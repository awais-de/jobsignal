from pipeline.rank import SkillIndex
from pipeline.skills_db import skills_from_rows


def test_rows_become_the_profile_skill_structure_with_a_stamp():
    rows = [
        {"name": "SQL", "category": "data", "aliases": ["sql", "t-sql", "microsoft sql server"], "rating": 8, "from_profile": True,
         "stamp": "2026-10-14T09:00:00+00:00"},
        {"name": "Databricks", "category": "cloud", "aliases": ["databricks"], "rating": 3, "from_profile": False,
         "stamp": "2026-10-14T10:00:00+00:00"},
        {"name": "Python", "category": None, "aliases": ["py"], "rating": None, "from_profile": True, "stamp": None},
    ]
    skills, stamp = skills_from_rows(rows)
    assert skills == {"data": {"SQL": ["microsoft sql server", "t-sql"]}, "cloud": {"Databricks": []}, "other": {"Python": ["py"]}}
    assert stamp == "2026-10-14T10:00:00+00:00"
    idx = SkillIndex.from_profile({"skills": skills})
    assert idx.match("Microsoft SQL Server")[0] == "SQL" and idx.match("Python 3.12")[0] == "Python"


def test_no_rows_means_no_skills():
    assert skills_from_rows([]) == ({}, None)
