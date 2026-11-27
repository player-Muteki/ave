"""Prepare MV2V conditioning images and map candidates back to square-pixel working frames."""
from dataclasses import dataclass
import gc
from tempfile import TemporaryDirectory
import time

import numpy as np
from PIL import Image


@dataclass(frozen=True)
class VaceCanvas:
    source_size: tuple[int, int]
    model_size: tuple[int, int]

    def __post_init__(self):
        if any(type(n) is not int or n <= 0 for n in (*self.source_size, *self.model_size)):
            raise ValueError("invalid frame geometry")
        if any(n % 16 for n in self.model_size):
            raise ValueError("VACE dimensions must be multiples of 16")

    @property
    def content_box(self):
        """One integer rectangle shared by RGB, binary labels and the inverse mapping."""
        width, height = self.source_size
        mw, mh = self.model_size
        if width * mh >= height * mw:
            w, h = mw, max(1, (height * mw + width // 2) // width)
        else:
            w, h = max(1, (width * mh + height // 2) // height), mh
        left, top = (mw - w) // 2, (mh - h) // 2
        return left, top, left + w, top + h

    def condition(self, rgb, raw_mask, allowed_region):
        """Return model video, white-edit mask and derived alpha on the source grid."""
        width, height = self.source_size
        if rgb.shape != (height, width, 3) or rgb.dtype != np.uint8:
            raise ValueError("RGB24 working frame does not match source geometry")
        if raw_mask.shape != (height, width) or raw_mask.dtype != np.uint8:
            raise ValueError("object label does not match source geometry")
        if np.any((raw_mask != 0) & (raw_mask != 255)):
            raise ValueError("expected a binary 0/255 object label")
        if allowed_region.shape != (height, width) or allowed_region.dtype != np.bool_:
            raise ValueError("allowed region must be boolean on the source grid")
        alpha = np.where(allowed_region, raw_mask, np.uint8(0))
        left, top, right, bottom = self.content_box
        size = right - left, bottom - top
        scaled = np.asarray(Image.fromarray(rgb).resize(size, Image.Resampling.LANCZOS))
        mw, mh = self.model_size
        padded = np.pad(scaled, ((top, mh - bottom), (left, mw - right), (0, 0)), mode="edge")
        mask = Image.new("L", self.model_size, 0)
        mask.paste(Image.fromarray(alpha).resize(size, Image.Resampling.NEAREST), (left, top))
        condition = Image.fromarray(padded)
        condition.paste((127, 127, 127), mask=mask)
        return condition, mask.convert("RGB"), alpha

    def restore(self, candidate):
        if candidate.size != self.model_size or candidate.mode != "RGB":
            raise ValueError("candidate is not an RGB frame on the model canvas")
        return np.asarray(candidate.crop(self.content_box).resize(self.source_size, Image.Resampling.LANCZOS))


def _encode_prompts(model, offload, prompt, negative_prompt):
    import torch
    from diffusers import WanVACEPipeline
    from transformers import AutoTokenizer, UMT5EncoderModel

    tokenizer = AutoTokenizer.from_pretrained(model / "tokenizer", local_files_only=True)
    encoder = UMT5EncoderModel.from_pretrained(
        model / "text_encoder", torch_dtype=torch.bfloat16, use_safetensors=True, device_map="auto",
        max_memory={0: "4GiB", "cpu": "2GiB"}, offload_folder=str(offload), local_files_only=True,
    )
    text = WanVACEPipeline(tokenizer, encoder, None, None)
    pos, neg = text.encode_prompt(prompt, negative_prompt=negative_prompt, device=torch.device("cuda"),
                                  max_sequence_length=128)
    return pos.cpu(), neg.cpu()


def generate_shot(model, scratch, controls, masks, *, prompt, negative_prompt, steps, seed):
    """Run the validated 9-frame 480p profile with a local Diffusers snapshot."""
    import diffusers
    import torch
    import transformers
    from diffusers import AutoencoderKLWan, WanVACEPipeline

    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise RuntimeError("the E08 profile requires a BF16-capable CUDA device")
    if len(controls) != 9 or len(masks) != 9:
        raise ValueError("the 480p shot profile requires nine frames and nine masks")
    if any(image.mode != "RGB" or image.size != (832, 480) for image in [*controls, *masks]):
        raise ValueError("the 480p shot profile requires 832x480 RGB inputs")
    torch.cuda.reset_peak_memory_stats()
    start = time.perf_counter()
    with torch.inference_mode():
        with TemporaryDirectory(dir=scratch) as offload:
            pos, neg = _encode_prompts(model, offload, prompt, negative_prompt)
            gc.collect()
            torch.cuda.empty_cache()
        encoded = time.perf_counter()
        vae = AutoencoderKLWan.from_pretrained(model / "vae", torch_dtype=torch.float32,
                                               use_safetensors=True, local_files_only=True)
        pipe = WanVACEPipeline.from_pretrained(model, text_encoder=None, tokenizer=None, vae=vae,
                                               torch_dtype=torch.bfloat16, use_safetensors=True,
                                               local_files_only=True)
        pipe.vae.enable_tiling()
        pipe.enable_model_cpu_offload()
        frames = pipe(video=controls, mask=masks, width=832, height=480, num_frames=9,
                      prompt_embeds=pos.cuda(), negative_prompt_embeds=neg.cuda(),
                      num_inference_steps=steps, guidance_scale=5.0,
                      generator=torch.Generator("cpu").manual_seed(seed), output_type="pil").frames[0]
    if len(frames) != 9:
        raise ValueError("incomplete VACE shot")
    return frames, {"gpu": torch.cuda.get_device_name(), "torch": torch.__version__,
                    "cuda": torch.version.cuda, "diffusers": diffusers.__version__,
                    "transformers": transformers.__version__, "textSeconds": encoded - start,
                    "generationSeconds": time.perf_counter() - encoded,
                    "peakAllocatedBytes": torch.cuda.max_memory_allocated(),
                    "peakReservedBytes": torch.cuda.max_memory_reserved()}
