"""Market demand per skill (invented postings; spec 13.1)."""

from datetime import date

from pipeline import skill_demand as sd

CONFIG = {"terms": [
    {"name": "Python", "pattern": r"\bPython\b"},
    {"name": "SQL", "pattern": r"\bSQL\b", "covers": ["t-sql"]},
    {"name": "Artificial Intelligence", "pattern": r"\b(AI|KI)\b", "case": True, "covers": ["ai"], "generic": True},
]}
CATALOG = [{"id": "s-ai", "name": "Artificial Intelligence", "name_key": "artificial intelligence", "aliases": ["ai"]},
           {"id": "s-sql", "name": "Structured Query Language", "name_key": "structured query language", "aliases": ["t-sql"]},
           {"id": "s-wb", "name": "Widget Builder", "name_key": "widget builder", "aliases": ["widgetbuilder"]}]


def shares(rows):
    """Company share per skill from one (week, scope, family) group of rows."""
    rows = list(rows)
    total = next((r["companies"] for r in rows if r["skill"] == sd.TOTAL), 0)
    return {r["skill"]: r["companies"] / total for r in rows if r["skill"] != sd.TOTAL and total}


PAD = " Lorem ipsum dolor sit amet, consectetur adipiscing elit." * 6


def post(i, company, family, body, source="arbeitnow"):
    return {"id": str(i), "company_key": company, "title": "Data Engineer", "title_family": family, "source": source,
            "description": body + PAD}


def test_vocabulary_links_terms_to_the_catalogue_and_adds_uncovered_skills():
    terms = {t.name: t for t in sd.vocabulary(CATALOG, CONFIG)}
    assert terms["SQL"].skill_id == "s-sql"                       # linked through 'covers'
    assert terms["Artificial Intelligence"].generic and terms["Artificial Intelligence"].skill_id == "s-ai"
    assert terms["Python"].skill_id is None                       # not in the catalogue: a missing skill
    assert terms["Widget Builder"].pattern.search("we use WidgetBuilder daily")


def test_companies_count_once_and_boilerplate_and_benefits_are_cut():
    intro = "Beispiel GmbH builds AI products for everyone and is growing fast across Europe. "
    rows = [post(i, "beispiel", "core_data", intro + "\nYour profile\nPython and SQL.\nWe offer\nAI training budget.")
            for i in range(4)]
    rows.append(post(9, "muster", "core_data", "Your tasks\nBuild SQL models.\nBenefits\nPython snacks."))
    out = sd.compute(rows, sd.vocabulary(CATALOG, CONFIG), date(2026, 10, 19))
    s = shares(r for r in out if r["scope"] == "all" and r["family"] == "core_data")
    assert s["SQL"] == 1.0                 # both companies
    assert s["Python"] == 0.5              # only Beispiel: Muster's Python is in the benefits
    assert "Artificial Intelligence" not in s    # Beispiel's intro is boilerplate, its benefits are cut
    total = next(r for r in out if r["scope"] == "all" and r["family"] == "core_data" and r["skill"] == "*")
    assert (total["companies"], total["postings"]) == (2, 5)


def test_scopes_and_the_all_family():
    rows = [post(1, "a", "core_data", "Your profile\nPython"), post(2, "b", "ai_ml", "Your profile\nPython", source="careers")]
    out = sd.compute(rows, sd.vocabulary([], CONFIG), date(2026, 10, 19))
    fams = {(r["scope"], r["family"]) for r in out if r["skill"] == "*"}
    assert fams == {("all", "core_data"), ("all", "ai_ml"), ("all", "all"), ("stable", "core_data"), ("stable", "all")}
    assert shares(r for r in out if r["scope"] == "all" and r["family"] == "all")["Python"] == 1.0


def test_postings_without_family_or_text_are_left_out():
    rows = [post(1, "a", None, "Python"), {**post(2, "b", "core_data", ""), "description": "Python"}]
    assert sd.compute(rows, sd.vocabulary([], CONFIG), date(2026, 10, 19)) == []


def test_weeks_to_compute():
    assert sd.weeks_to_compute(date(2026, 10, 23)) == [date(2026, 10, 12), date(2026, 10, 19)]
    assert sd.weeks_to_compute(date(2026, 10, 19), back=0) == [date(2026, 10, 19)]


def test_the_shipped_vocabulary_compiles():
    terms = sd.vocabulary([])
    assert len(terms) > 50 and {"Python", "SQL", "dbt"} <= {t.name for t in terms}
