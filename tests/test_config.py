from pathlib import Path

import pytest

from pipeline.config import CONFIG_DIR, ConfigError, load_profile

EXAMPLE = CONFIG_DIR / "profile.example.yaml"
MISSING = Path("/nonexistent/profile.yaml")


def test_example_profile_is_valid():
    profile = load_profile(env={"PROFILE_YAML": EXAMPLE.read_text()}, path=MISSING)
    assert profile["contract_types"] == ["full_time"]


def test_env_takes_precedence_over_file():
    profile = load_profile(env={"PROFILE_YAML": EXAMPLE.read_text()}, path=EXAMPLE)
    assert "titles" in profile


def test_no_fallback_to_example():
    with pytest.raises(ConfigError, match="No profile found"):
        load_profile(env={}, path=MISSING)


def test_missing_keys_reported():
    with pytest.raises(ConfigError, match="missing keys: .*feed"):
        load_profile(env={"PROFILE_YAML": "titles: {}\nlocation: {}\n"}, path=MISSING)


def test_invalid_yaml_does_not_echo_content():
    with pytest.raises(ConfigError) as exc:
        load_profile(env={"PROFILE_YAML": "secret_value: [unclosed"}, path=MISSING)
    assert "secret_value" not in str(exc.value)


def test_invalid_title_pattern_is_dropped_not_fatal():
    from pipeline.config import validate_profile
    import yaml
    prof = yaml.safe_load(EXAMPLE.read_text())
    prof["titles"]["allow"] = ["data engineer", "(unclosed"]
    assert validate_profile(prof, "test")["titles"]["allow"] == ["data engineer"]
