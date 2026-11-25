"""Build a candidate materials SBOM from the staged application and native source locks."""
import argparse
import json
from pathlib import Path
import re
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("runtime", type=Path, help="The identity-patched Paseo build directory")
    parser.add_argument("source_sha", help="The AVE candidate commit")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.source_sha):
        raise ValueError("Expected a full Git commit")
    root = Path(__file__).resolve().parents[2]
    def source_file(name):
        return subprocess.check_output(["git", "show", f"{args.source_sha}:{name}"], cwd=root, text=True)

    sbom = json.loads(subprocess.check_output([
        "npm", "sbom", "--sbom-format=cyclonedx", "--package-lock-only", "--omit=dev",
        "--workspace=@getpaseo/desktop", "--workspace=@getpaseo/app",
    ], cwd=args.runtime, text=True))
    components = {}
    for component in sbom["components"]:
        ref = component["bom-ref"]
        if ref in components:
            previous = components[ref]
            if {k: v for k, v in previous.items() if k != "properties"} != {
                k: v for k, v in component.items() if k != "properties"
            }:
                raise ValueError(f"Conflicting npm components with the same reference: {ref}")
            for prop in component.get("properties", []):
                if prop not in previous.setdefault("properties", []):
                    previous["properties"].append(prop)
        else:
            components[ref] = component
    graph = {}
    for edge in sbom["dependencies"]:
        graph.setdefault(edge["ref"], set()).update(edge["dependsOn"])

    package = json.loads((args.runtime / "packages/desktop/package.json").read_text())
    upstream = next(ref for ref in json.loads(source_file("research/upstream.json"))["references"] if ref["path"] == "paseo")
    root_component = sbom["metadata"]["component"]
    root_component["name"] = "Paseo workspace"
    root_component.setdefault("properties", []).append({"name": "ave:upstream-commit", "value": upstream["commit"]})
    components[root_component["bom-ref"]] = root_component
    ave = f"AVE@{package['version']}+{args.source_sha}"
    sbom["metadata"]["component"] = {
        "type": "application", "name": "AVE", "version": package["version"], "bom-ref": ave,
        "externalReferences": [{"type": "vcs", "url": f"https://github.com/player-Muteki/ave/tree/{args.source_sha}"}],
        "description": "Production npm workspace dependencies and native materials for the four desktop targets.",
    }
    graph[ave] = {root_component["bom-ref"]}
    def native(name, version, url, license_id):
        ref = f"{name}@{version}"
        components[ref] = {
            "name": name, "version": version, "bom-ref": ref, "type": "framework",
            "licenses": [{"license": {"id": license_id}}],
            "externalReferences": [{"type": "distribution", "url": url}],
        }
        graph[ave].add(ref)
        return components[ref]

    lock = json.loads(source_file("downstream/paseo/package-lock.json"))
    electron = lock["packages"]["node_modules/electron"]["version"]
    native("Electron", electron, f"https://github.com/electron/electron/releases/tag/v{electron}", "MIT")
    build = source_file("release/desktop/build-media.sh")
    for key, repo, name in [("ffmpeg", "FFmpeg/FFmpeg", "FFmpeg"), ("x264", "mirror/x264", "x264")]:
        commit = re.search(r'git -C "\$' + key + r'" rev-parse HEAD\)" = ([0-9a-f]{40})', build)
        if not commit:
            raise ValueError(f"Missing locked source for {name}")
        sha = commit.group(1)
        native(name, sha, f"https://github.com/{repo}/archive/{sha}.tar.gz", "GPL-2.0-or-later")
    zlib = "zlib:host-build-dependency"
    components[zlib] = {
        "name": "zlib", "bom-ref": zlib, "type": "library",
        "description": "Native build dependency selected on each runner for PNG support in FFmpeg.",
        "licenses": [{"license": {"id": "Zlib"}}],
        "externalReferences": [{"type": "website", "url": "https://zlib.net/"}],
    }
    graph.setdefault(next(ref for ref in components if ref.startswith("FFmpeg@")), set()).add(zlib)
    for target, archive in json.loads(source_file("release/desktop/python-lock.json")).items():
        python_version = re.search(r"/cpython-([0-9.]+)%2B", archive["url"])
        if not python_version:
            raise ValueError(f"Missing CPython version for {target}")
        component = native(f"CPython Build Standalone ({target})", python_version.group(1), archive["url"], "Python-2.0")
        component["externalReferences"][0]["hashes"] = [{"alg": "SHA-256", "content": archive["sha256"]}]

    for ref, requires in graph.items():
        if (ref != ave and ref not in components) or requires - components.keys():
            raise ValueError(f"Unresolved SBOM dependency for {ref}")
    sbom["components"] = list(components.values())
    sbom["dependencies"] = [{"ref": ref, "dependsOn": sorted(children)} for ref, children in graph.items()]
    args.output.write_text(json.dumps(sbom, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
