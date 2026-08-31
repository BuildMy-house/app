from pathlib import Path

import pytest

from luxcore.bridge import _asset_materials, _load_mtl, _load_obj_full

MANNEQUIN = (
    Path(__file__).parents[2]
    / "homely"
    / "assets"
    / "models"
    / "sh3d"
    / "mannequin"
    / "mannequin.obj"
)

_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d494844520000000100000001080600000"
    "01f15c4890000000d49444154789c626001000000ffff030000060005"
    "57bfabd40000000049454e44ae426082"
)


def test_mannequin_mtl_parses_flat_kd():
    # Real fixture: 29 materials, all Kd, no vt -> no texture, flat Kd.
    loaded = _load_obj_full(str(MANNEQUIN), [1, 1, 1], [0, 0, 0], 0)
    assert loaded["coverage"] == 0.0
    assert loaded["uvs"] is None
    assert loaded["materials"]["Abdomen"]["kd"] == pytest.approx([0.744089, 0.602354, 0.402309])
    assert loaded["materials"]["Abdomen"]["textured"] is False
    assert len(loaded["face_materials"]) == len(loaded["faces"])
    assert set(loaded["face_materials"]) == set(loaded["materials"])


def test_asset_materials_returns_none_without_mtl(tmp_path: Path):
    obj = tmp_path / "plain.obj"
    obj.write_text("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n", encoding="utf-8")
    assert _asset_materials(str(obj)) is None


def test_full_uv_map_kd_is_textured(tmp_path: Path):
    (tmp_path / "tex.png").write_bytes(_PNG)
    (tmp_path / "mat.mtl").write_text(
        "newmtl wall\nKd 0.5 0.5 0.5\nmap_Kd tex.png\n", encoding="utf-8"
    )
    obj = tmp_path / "full.obj"
    obj.write_text(
        "mtllib mat.mtl\n"
        "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\n"
        "vt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\n"
        "usemtl wall\n"
        "f 1/1 2/2 3/3 4/4\n",
        encoding="utf-8",
    )
    loaded = _load_obj_full(str(obj), [1, 1, 1], [0, 0, 0], 0)
    assert loaded["coverage"] == 1.0
    assert loaded["uvs"] is not None
    assert loaded["materials"]["wall"]["textured"] is True
    assert loaded["materials"]["wall"]["map_kd"] == str((tmp_path / "tex.png").resolve())


def test_sparse_uv_falls_back_to_flat_kd(tmp_path: Path):
    (tmp_path / "tex.png").write_bytes(_PNG)
    (tmp_path / "mat.mtl").write_text(
        "newmtl wall\nKd 0.5 0.5 0.5\nmap_Kd tex.png\n", encoding="utf-8"
    )
    obj = tmp_path / "sparse.obj"
    obj.write_text(
        "mtllib mat.mtl\n"
        "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 0 0 1\n"
        "vt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\n"
        "usemtl wall\n"
        "f 1/1 2/2 3/3 4/4\n"
        "f 5 2 3\n",
        encoding="utf-8",
    )
    loaded = _load_obj_full(str(obj), [1, 1, 1], [0, 0, 0], 0)
    assert loaded["coverage"] == pytest.approx(0.5)
    assert loaded["uvs"] is None
    assert loaded["materials"]["wall"]["textured"] is False
    assert loaded["materials"]["wall"]["kd"] == pytest.approx([0.5, 0.5, 0.5])


def test_load_mtl_parses_kd_and_map(tmp_path: Path):
    mtl = tmp_path / "m.mtl"
    mtl.write_text(
        "newmtl a\nKd 0.1 0.2 0.3\n"
        "newmtl b\nmap_Kd foo/bar.png\n",
        encoding="utf-8",
    )
    parsed = _load_mtl(mtl)
    assert parsed["a"]["kd"] == pytest.approx([0.1, 0.2, 0.3])
    assert parsed["b"]["map_kd"] == "foo/bar.png"
