"""STEMB health-economics ledger — QALY gained and cost avoided per patient.

Turns a screening outcome into an illustrative economic effect so the value of
EARLY detection is visible, not just the risk number.

`ponytail:` all parameters are ILLUSTRATIVE priors, not a validated cost-
effectiveness model — no real cohort, no local price data. They exist to make the
STEMB story concrete and are fully exposed in `assumptions` for audit. Upgrade:
populate from GBA payer data (HK Hospital Authority / Macau SSM) and fit the
case-probability mapping on labelled outcomes.
"""

from __future__ import annotations

from .config import ENGINE_VERSION
from .contract import ValuationEffect

_DISCLAIMER = (
    "Illustrative health-economic estimate — not a clinical or reimbursement "
    "determination. Parameters are priors, not local price data."
)

# --- illustrative parameters (HKD) ----------------------------------------- #
_PARAMS: dict[str, float] = {
    "horizonYears": 5.0,
    "utilityGainPerYear": 0.10,        # QALY/yr utility recovered by early care
    "valuePerQaly": 500_000.0,         # cost-effectiveness threshold (HKD/QALY)
    "lateDiagnosisCost": 180_000.0,    # acute care + institutionalisation avoided
    "earlyProgramCost": 8_000.0,       # annual structured screening + follow-up
    "minDiscernibleRisk": 0.35,        # below this we assume no attributable case
}
# band -> illustrative probability that this screen surfaces a true early case
_CASE_PROB = {"low": 0.05, "watch": 0.35, "elevated": 0.70}


def estimate(risk_index: float, band: str) -> ValuationEffect:
    """-> ValuationEffect for one screening result."""
    p_case = _CASE_PROB.get(band, 0.05)
    if risk_index < _PARAMS["minDiscernibleRisk"]:
        p_case = min(p_case, _CASE_PROB["low"])

    qaly_gained = p_case * _PARAMS["utilityGainPerYear"] * _PARAMS["horizonYears"]
    gross_avoided = p_case * _PARAMS["lateDiagnosisCost"]
    cost_saved = gross_avoided - _PARAMS["earlyProgramCost"]
    if cost_saved < 0:
        cost_saved = 0.0

    return ValuationEffect(
        qalyGained=round(float(qaly_gained), 4),
        costSavedPerPatient=round(float(cost_saved), 2),
        currency="HKD",
        horizonYears=_PARAMS["horizonYears"],
        assumptions={
            "caseProbability": p_case,
            "valuePerQaly": _PARAMS["valuePerQaly"],
            "lateDiagnosisCost": _PARAMS["lateDiagnosisCost"],
            "earlyProgramCost": _PARAMS["earlyProgramCost"],
            "qalyMonetaryValue": round(qaly_gained * _PARAMS["valuePerQaly"], 2),
        },
        disclaimer=f"{_DISCLAIMER} ({ENGINE_VERSION})",
    )