from luxcore.asset_store import AssetStore


def test_asset_store_isolated_and_backed_up(tmp_path):
    store = AssetStore(tmp_path)
    record = {"id": "asset-1", "name": "Chair"}
    store.put("user-1", record, b"glb", b"obj")
    store.put("user-1", record, b"glb-new", b"obj-new")

    assert store.get("user-1", "asset-1") == b"glb-new"
    assert store.get("user-1", "asset-1", source=True) == b"obj-new"
    assert (tmp_path / "user-1" / "manifest.json.bak").exists()
    assert store.list("user-2") == []
