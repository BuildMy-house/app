import struct
import tempfile
import zipfile
from pathlib import Path

from eq.sh3d_textures import Sh3dTextureExtractor


def _minimal_png() -> bytes:
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr_data = struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)
    ihdr_crc = b'\x00' * 4
    ihdr = struct.pack('>I', 13) + b'IHDR' + ihdr_data + ihdr_crc
    idat_data = b'\x00\x80\x80\x80'
    idat_crc = b'\x00' * 4
    idat = struct.pack('>I', len(idat_data)) + b'IDAT' + idat_data + idat_crc
    iend = struct.pack('>I', 0) + b'IEND' + b'\x00' * 4
    return sig + ihdr + idat + iend


def _make_test_sh3d(tmp_path: Path) -> Path:
    sh3d = tmp_path / "test.sh3d"
    home_xml = '''<?xml version="1.0" encoding="UTF-8"?>
<home version="6.5" name="Test">
  <textures>
    <texture name="wood" image="textures/wood.png" width="512" height="512"/>
  </textures>
  <walls>
    <wall id="w1" leftSideTexture="wood" rightSideTexture="wood"/>
  </walls>
  <rooms>
    <room id="r1" floorTexture="wood" ceilingTexture=""/>
  </rooms>
  <furniture>
    <item id="f1" texture=""/>
  </furniture>
</home>'''
    with zipfile.ZipFile(sh3d, 'w') as zf:
        zf.writestr('home.xml', home_xml)
        zf.writestr('textures/wood.png', _minimal_png())
    return sh3d


def test_texture_map():
    with tempfile.TemporaryDirectory() as tmp:
        sh3d = _make_test_sh3d(Path(tmp))
        with Sh3dTextureExtractor(str(sh3d)) as ext:
            tex_map = ext.get_texture_map()
            assert 'wood' in tex_map
            assert tex_map['wood'] == 'textures/wood.png'


def test_wall_textures():
    with tempfile.TemporaryDirectory() as tmp:
        sh3d = _make_test_sh3d(Path(tmp))
        with Sh3dTextureExtractor(str(sh3d)) as ext:
            walls = ext.get_wall_textures()
            assert walls['w1']['left'] == 'wood'
            assert walls['w1']['right'] == 'wood'


def test_room_textures():
    with tempfile.TemporaryDirectory() as tmp:
        sh3d = _make_test_sh3d(Path(tmp))
        with Sh3dTextureExtractor(str(sh3d)) as ext:
            rooms = ext.get_room_textures()
            assert rooms['r1']['floor'] == 'wood'


def test_extract_textures():
    with tempfile.TemporaryDirectory() as tmp:
        sh3d = _make_test_sh3d(Path(tmp))
        out = Path(tmp) / 'extracted'
        with Sh3dTextureExtractor(str(sh3d)) as ext:
            extracted = ext.extract_textures(out)
            assert 'wood' in extracted
            assert extracted['wood'].exists()
