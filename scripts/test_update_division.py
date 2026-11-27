"""Regression coverage for DIVISION's root commit and downstream line accounting."""
from pathlib import Path
import json
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

SCRIPT = Path(__file__).with_name('update_division.py')


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()


def initialize(repo, author):
    repo.mkdir(exist_ok=True)
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.name', author)
    git(repo, 'config', 'user.email', 'fixture@example.invalid')


class DivisionTest(unittest.TestCase):
    def test_local_author_gets_only_downstream_delta(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            initialize(root, 'luochuhao')
            upstream = root / 'paseo'
            initialize(upstream, 'upstream')
            (upstream / 'editor.ts').write_text('original();\nbefore();\n')
            git(upstream, 'add', '.')
            git(upstream, 'commit', '-qm', 'base')
            base = git(upstream, 'rev-parse', 'HEAD')
            (root / 'research').mkdir()
            (root / 'research/upstream.json').write_text(json.dumps({'references': [{'path': 'paseo', 'commit': base}]}))
            overlay = root / 'downstream/paseo'
            overlay.mkdir(parents=True)
            (overlay / 'editor.ts').write_text('original();\nafter();\n')
            (overlay / 'new.ts').write_text('// comment\nadded();\n')
            git(root, 'add', 'research', 'downstream')
            git(root, 'commit', '-qm', 'feat: editor')
            output = root / 'division.svg'
            subprocess.run([sys.executable, str(SCRIPT), '--repo', str(root), '--output', str(output)], check=True)
            labels = [e.text for e in ET.parse(output).getroot().iter('{http://www.w3.org/2000/svg}text')]
            member = labels[labels.index('L'):labels.index('J')]
            self.assertIn('提交 1', member)
            self.assertIn('有效代码 2 行', member)


if __name__ == '__main__':
    unittest.main()
