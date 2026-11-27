"""CPU regression checks for VACE geometry, mask polarity and protected boundaries."""
from pathlib import Path
import sys
import unittest

import numpy as np
from PIL import Image

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services/media-worker"))
from vace_shot import VaceCanvas


class VaceCanvasTest(unittest.TestCase):
    def test_odd_dimensions_and_aligned_polarity(self):
        for size, box in (((91, 177), (292, 0, 539, 480)), ((641, 359), (0, 7, 832, 473))):
            with self.subTest(size=size):
                width, height = size
                canvas = VaceCanvas(size, (832, 480))
                self.assertEqual(canvas.content_box, box)
                rgb = np.full((height, width, 3), (20, 90, 150), dtype=np.uint8)
                raw = np.full((height, width), 255, dtype=np.uint8)
                allowed = np.zeros((height, width), dtype=bool)
                allowed[height//4:height//2, width//3:width//2] = True
                video, mask, alpha = canvas.condition(rgb, raw, allowed)
                np.testing.assert_array_equal(alpha != 0, allowed)
                expected = Image.new("L", canvas.model_size)
                left, top, right, bottom = box
                expected.paste(Image.fromarray(alpha).resize((right-left, bottom-top), Image.Resampling.NEAREST),
                               (left, top))
                np.testing.assert_array_equal(np.asarray(mask.convert("L")), np.asarray(expected))
                selected = np.asarray(expected) != 0
                self.assertTrue(np.all(np.asarray(video)[selected] == 127))
                self.assertTrue(np.all(np.asarray(video)[~selected] == (20, 90, 150)))
                # Lose the padding completely before inverse resize, including the odd extra pixel.
                candidate = Image.new("RGB", canvas.model_size, (255, 0, 0))
                candidate.paste((20, 90, 150), box)
                np.testing.assert_array_equal(canvas.restore(candidate), rgb)

    def test_rejects_nonbinary_label(self):
        canvas = VaceCanvas((3, 2), (16, 16))
        image = np.zeros((2, 3, 3), dtype=np.uint8)
        with self.assertRaisesRegex(ValueError, "binary"):
            canvas.condition(image, image[:, :, 0] + 127, np.ones((2, 3), dtype=bool))


if __name__ == "__main__":
    unittest.main()
