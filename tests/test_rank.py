from pipeline.rank import SkillIndex, score

PROFILE = {
    "skills": {
        "data_engineering": {"python": ["pandas"], "sql": ["t-sql"], "pyspark": ["spark", "apache spark"],
                             "azure data factory": ["adf"], "dbt": []},
        "bi_analytics": {"power bi": ["powerbi", "dax"]},
    },
    "preferences": {"skills_bonus": ["dbt", "python"], "remote_bonus": True},
}
WEIGHTS = {"w_fit": 0.7, "preferred_skill_bonus": 2, "preferred_skill_bonus_cap": 10,
           "remote_bonus": 5, "preference_bonus_cap": 15}
INDEX = SkillIndex.from_profile(PROFILE)


def test_alias_and_word_matching():
    assert INDEX.match("ADF")[0] == "azure data factory"
    assert INDEX.match("Python 3.11")[0] == "python"
    assert INDEX.match("Apache Spark")[0] == "pyspark"
    assert INDEX.match("PowerBI")[0] == "power bi"
    assert INDEX.match("Kubernetes") is None
    assert INDEX.match("MySQL") is None          # 'sql' must not match inside another word


def test_score_and_details():
    fit, rank, d = score({"must_have_skills": ["Python", "SQL", "Kubernetes", "Spark"],
                          "nice_to_have_skills": ["dbt"]}, "hybrid", INDEX, PROFILE, WEIGHTS)
    assert fit == 75.0
    assert d["matched"] == ["Python", "SQL", "Spark"] and d["missing"] == ["Kubernetes"]
    assert d["preferred"] == ["dbt", "python"]
    assert d["bonus"] == 9.0                      # 2 preferred × 2 + remote 5
    assert rank == round(0.7 * 75 + 9, 1)
    assert d["track"] == "data_engineering"


def test_few_must_haves_cannot_reach_full_fit():
    fit, _, _ = score({"must_have_skills": ["Python", "SQL"]}, None, INDEX, PROFILE, {**WEIGHTS, "min_must_haves": 3})
    assert round(fit, 1) == 66.7


def test_no_must_haves_scores_zero_fit():
    fit, rank, d = score({"must_have_skills": []}, None, INDEX, PROFILE, WEIGHTS)
    assert fit == 0 and rank == 0 and d["matched"] == []
