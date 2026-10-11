from datetime import date

from chunking_lab.financials import annual_values


def fact(start, end, val, filed, form="10-K", accn="0000000000-25-000001"):
    return {"start": start, "end": end, "val": val, "filed": filed, "form": form, "accn": accn}


FACTS = {"facts": {"us-gaap": {
    "RevenueFromContractWithCustomerExcludingAssessedTax": {"units": {"USD": [
        fact("2024-01-01", "2024-12-31", 100, "2025-02-01"),
        fact("2024-01-01", "2024-12-31", 105, "2026-02-01"),        # restated later: wins
        fact("2024-10-01", "2024-12-31", 30, "2025-02-01"),         # a quarter: ignored
        fact("2023-01-01", "2023-12-31", 90, "2024-02-01", form="10-Q"),  # not a 10-K: ignored
    ]}},
    "Revenues": {"units": {"USD": [
        fact("2024-01-01", "2024-12-31", 999, "2025-02-01"),        # lower-priority tag: ignored
        fact("2023-01-01", "2023-12-31", 80, "2024-02-01"),         # only source for 2023: used
    ]}},
}}}


def test_annual_values_prefers_tags_restatements_and_full_years():
    tags = ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues"]
    out = annual_values(FACTS, tags)
    assert set(out) == {date(2024, 12, 31), date(2023, 12, 31)}
    assert out[date(2024, 12, 31)]["value"] == 105
    assert out[date(2024, 12, 31)]["tag"] == tags[0]
    assert out[date(2023, 12, 31)]["value"] == 80 and out[date(2023, 12, 31)]["tag"] == "Revenues"


def test_annual_values_missing_tag_is_empty():
    assert annual_values(FACTS, ["GrossProfit"]) == {}
