import json

import httpx
import pytest

from pipeline.extract import regex
from pipeline.extract.jd import SCHEMA, dealbreaker, extract, trim
from pipeline.llm.base import Completion, Unavailable
from pipeline.llm.groq import GroqProvider
from pipeline.llm.router import Router

# -- regex: German level --------------------------------------------------------


@pytest.mark.parametrize("text, level", [
    ("Sehr gute Deutschkenntnisse (mindestens C1) erforderlich.", "C1"),
    ("Deutsch auf Niveau B2 und Englisch C1", "B2"),
    ("German C2 or native", "C2"),
    ("Verhandlungssichere Deutschkenntnisse", "C1"),
    ("Deutsch fließend in Wort und Schrift", "C1"),
    ("Deutsch als Muttersprache", "C2"),
    ("Gute Deutschkenntnisse", "B2"),
    ("Fluent German and English required", "C1"),
    ("German is a plus but not required", "none"),
    ("Englisch verhandlungssicher", None),
    ("Englisch C2, Deutsch B2", "B2"),
    ("Englisch C2 und Deutsch B1", "B1"),
    ("C1-Deutschkenntnisse", "C1"),
    ("Deutsch: B2, Englisch: C2", "B2"),
    ("We build data pipelines.", None),
])
def test_german_level(text, level):
    assert regex.german_level(text) == level


# -- regex: years ---------------------------------------------------------------


@pytest.mark.parametrize("text, years", [
    ("Mindestens 3 Jahre Berufserfahrung im Data Engineering", 3),
    ("4-6 years of experience with Spark", 4),
    ("5+ years of professional experience", 5),
    ("Experience: at least 2 years", 2),
    ("Seit 50 Jahren sind wir Marktführer.", None),       # not an experience context
    ("Erste Berufserfahrung wünschenswert", None),
])
def test_required_years(text, years):
    assert regex.required_years(text) == years


@pytest.mark.parametrize("title, kind", [
    ("Werkstudent Data Engineering (m/w/d)", "werkstudent"),
    ("Data Engineer (m/w/d) in Teilzeit", "part_time"),
    ("Data Engineer – Vollzeit", "full_time"),
    ("Data Engineer (m/w/d)", None),
])
def test_contract_type_from_title(title, kind):
    assert regex.contract_type(title) == kind


def test_evergreen():
    assert regex.evergreen("Initiativbewerbung für unseren Talent Pool")
    assert not regex.evergreen("Wir suchen ab sofort eine Data Engineerin.")


# -- trimming ---------------------------------------------------------------------


def test_trim_drops_benefits_section():
    text = "Aufgaben:\nPipelines bauen\n\nWas wir bieten:\nObstkorb\nJobrad\n\nProfil:\nPython"
    out = trim(text, 8000)
    assert "Pipelines bauen" in out and "Python" in out and "Obstkorb" not in out


# -- merge and dealbreakers -------------------------------------------------------

LLM_RESULT = {
    "must_have_skills": ["Python", "SQL", "Kubernetes"], "nice_to_have_skills": ["dbt"],
    "seniority": "mid", "required_years": 2, "german_level": "B2", "english_level": "C1",
    "contract_type": "part_time", "remote_policy": "hybrid", "named_contact": None,
    "reference_number": None, "start_date_text": None, "salary_text": None,
    "specificity": {"named_team": True, "concrete_project": True, "named_manager": False},
    "evergreen_language": False,
}


class FakeProvider:
    name, model = "fake", "fake-1"

    def __init__(self, result=None, exc=None):
        self.result, self.exc, self.calls = result, exc, 0

    def complete_json(self, system, user, schema, max_tokens):
        self.calls += 1
        if self.exc:
            raise self.exc
        return Completion(self.result, self.name, self.model, 100, 50)


CFG = {"prompt_version": "test", "max_input_chars": 8000}


def test_regex_wins_and_source_contract_beats_llm():
    router = Router([FakeProvider(LLM_RESULT)], max_calls=5)
    ex = extract("Data Engineer", "Mindestens 5 Jahre Berufserfahrung. Deutsch C1.", router, CFG,
                 source_contract="full_time")
    assert ex.status == "done"
    assert ex.fields["required_years"] == 5          # regex, not the LLM's 2
    assert ex.fields["german_level"] == "C1"          # regex, not the LLM's B2
    assert ex.fields["contract_type"] == "full_time"  # source, not the LLM's part_time
    assert ex.fields["must_have_skills"] == ["Python", "SQL", "Kubernetes"]
    assert ex.fields["specificity_score"] == 2


def test_llm_failure_keeps_regex_fields_and_marks_failed():
    router = Router([FakeProvider(exc=Unavailable("rate_limited"))], max_calls=5)
    ex = extract("Data Engineer", "Deutsch C2 erforderlich.", router, CFG)
    assert ex.status == "failed" and ex.fields["german_level"] == "C2"


def test_no_description_is_skipped():
    assert extract("Data Engineer", None, Router([], 5), CFG).status == "skipped"


PROFILE = {"dealbreakers": {"max_required_years": 4.5, "max_german_level": "C1"}, "contract_types": ["full_time"]}


@pytest.mark.parametrize("fields, reason", [
    ({"required_years": 5}, "too_many_years"),
    ({"required_years": 4}, None),
    ({"german_level": "C2"}, "german_level"),
    ({"german_level": "C1"}, None),
    ({"german_level": "none"}, None),
    ({"contract_type": "werkstudent"}, "contract_type"),
])
def test_dealbreakers(fields, reason):
    assert dealbreaker(fields, PROFILE) == reason


# -- router -----------------------------------------------------------------------


def test_router_falls_through_and_caches():
    a, b = FakeProvider(exc=Unavailable("rate_limited")), FakeProvider(LLM_RESULT)
    router = Router([a, b], max_calls=10)
    first = router.complete_json("s", "k1", "sys", "u", SCHEMA, 100, validate=lambda d: True)
    assert first == LLM_RESULT and a.calls == 1 and b.calls == 1
    router.complete_json("s", "k2", "sys", "u", SCHEMA, 100, validate=lambda d: True)
    assert a.calls == 1                                # rate-limited provider dropped for the run
    router.complete_json("s", "k1", "sys", "u", SCHEMA, 100, validate=lambda d: True)
    assert b.calls == 2                                # k1 served from cache
    assert [u["success"] for u in router.usage] == [False, True, True]


def test_router_respects_call_cap():
    p = FakeProvider(LLM_RESULT)
    router = Router([p], max_calls=1)
    router.complete_json("s", "a", "sys", "u", SCHEMA, 100, validate=lambda d: True)
    assert router.complete_json("s", "b", "sys", "u", SCHEMA, 100, validate=lambda d: True) is None
    assert router.exhausted


def test_router_uses_persistent_cache():
    p = FakeProvider(LLM_RESULT)
    router = Router([p], max_calls=5, cache_get=lambda k: {"cached": True})
    assert router.complete_json("s", "x", "sys", "u", SCHEMA, 100, validate=lambda d: True) == {"cached": True}
    assert p.calls == 0 and router.last_model == "cache"


# -- Groq request shape -------------------------------------------------------------


def test_groq_request_and_rate_limit():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        if len(seen) == 1:
            return httpx.Response(429, headers={"retry-after": "3600"})    # daily quota: fall through
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(LLM_RESULT)}}],
                                         "usage": {"prompt_tokens": 10, "completion_tokens": 5}})

    groq = GroqProvider("openai/gpt-oss-120b", "k", client=httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(Unavailable, match="rate_limited"):        # retry-after too long to wait
        groq.complete_json("sys", "user", SCHEMA, 500)
    out = groq.complete_json("sys", "user", SCHEMA, 500)
    body = seen[-1]
    assert body["response_format"]["type"] == "json_schema"
    assert body["response_format"]["json_schema"]["strict"] is True
    assert body["reasoning_effort"] == "low" and out.data == LLM_RESULT and out.input_tokens == 10


def test_schema_is_strict_compatible():
    """Groq strict mode: every property required, additionalProperties false on every object."""
    def walk(node):
        if node.get("type") == "object":
            assert node["additionalProperties"] is False
            assert set(node["required"]) == set(node["properties"])
            for child in node["properties"].values():
                walk(child)
    walk(SCHEMA)
