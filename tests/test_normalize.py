import pytest

from pipeline.normalize import dedupe_hash, normalize_city, normalize_company, normalize_title


@pytest.mark.parametrize("raw, expected", [
    ("Beispiel Daten GmbH", "beispiel daten"),
    ("Beispiel Daten GmbH & Co. KG", "beispiel daten"),
    ("Musterfirma AG", "musterfirma"),
    ("Musterfirma SE", "musterfirma"),
    ("Exampleworks Inc.", "exampleworks"),
    ("Beispiel Daten GmbH Niederlassung Köln", "beispiel daten"),
    ("Agentur Muster e.V.", "agentur muster"),
    ("AGILE Muster", "agile muster"),            # 'ag' inside a word stays
])
def test_normalize_company(raw, expected):
    assert normalize_company(raw) == expected


@pytest.mark.parametrize("raw, expected", [
    ("Data Engineer (m/w/d)", "data engineer"),
    ("Data Engineer (w/m/d)", "data engineer"),
    ("Data Engineer (f/m/x)", "data engineer"),
    ("Data Engineer (all genders)", "data engineer"),
    ("Dateningenieur*in", "dateningenieur"),
    ("Data Analyst:in – Ref.-Nr. 12345", "data analyst"),
    ("BI-Entwickler (m/w/d)", "bi entwickler"),
    ("Data Science Engineer (m w d)", "data science engineer"),
])
def test_normalize_title(raw, expected):
    assert normalize_title(raw) == expected


@pytest.mark.parametrize("raw, expected", [
    ("Cologne", "köln"),
    ("München", "münchen"),
    ("Munich", "münchen"),
    ("Berlin, Mitte", "berlin"),
    ("Hamburg - Altona", "hamburg"),
    (None, ""),
])
def test_normalize_city(raw, expected):
    assert normalize_city(raw) == expected


def test_hash_ignores_cosmetic_differences():
    a = dedupe_hash("Beispiel Daten GmbH", "Data Engineer (m/w/d)", "Cologne")
    b = dedupe_hash("Beispiel Daten GmbH & Co. KG", "Data Engineer (all genders)", "Köln")
    assert a == b


def test_hash_differs_by_city():
    assert dedupe_hash("Beispiel", "Data Engineer", "Berlin") != dedupe_hash("Beispiel", "Data Engineer", "Hamburg")
