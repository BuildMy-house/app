from luxcore.profiles import PROFILES, settings_for


def test_render_profiles_are_complete_and_independent():
    assert set(PROFILES) == {"thumbnail", "low", "medium", "high"}
    assert settings_for("thumbnail")["width"] == 256
    assert settings_for("high")["samples_per_pixel"] == 4096
    assert settings_for("low") is not PROFILES["low"]
