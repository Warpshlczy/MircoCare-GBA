"""Weekly family report endpoints (C4).

Three consumers:
  * the senior app calls ``GET /reports/weekly/me`` for its own summary;
  * ``POST /reports/weekly/send`` queues the report to bound family accounts
    through the notification outbox (no provider is wired in the demo);
  * the caregiver page reads a bound senior through
    ``GET /caregiver/reports/weekly`` after the normal family auth check.

``.html`` variants render the same report with no external assets, for the
"open the family report page" demo step.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from fastapi.responses import HTMLResponse

from ..auth import Principal, current_principal
from ..contract import Locale, WeeklyReport
from ..notify import dispatch as notify_dispatch
from ..privacy import device_id
from ..reports.weekly import build_weekly_report, render_html, report_summary
from ..store import store
from .caregiver_routes import linked_device

router = APIRouter(tags=["reports"])


def _locale(value: str) -> Locale:
    return value if value in ("zh-HK", "zh-MO", "zh-CN") else "zh-CN"  # type: ignore[return-value]


@router.get("/reports/weekly/me", response_model=WeeklyReport)
def my_weekly_report(dev: str = Depends(device_id)) -> WeeklyReport:
    """The senior's own seven-day report."""
    return build_weekly_report(dev, store)


@router.get("/reports/weekly/me.html", response_class=HTMLResponse)
def my_weekly_report_html(dev: str = Depends(device_id)) -> HTMLResponse:
    return HTMLResponse(render_html(build_weekly_report(dev, store)))


@router.post("/reports/weekly/send", status_code=202)
def send_weekly_report(dev: str = Depends(device_id)) -> dict:
    """Queue the report to every family account bound to this senior.

    The outbox is the delivery seam: a push/SMS worker consumes it later, so the
    response says "queued", never "delivered".
    """
    report = build_weekly_report(dev, store)
    notified = notify_dispatch(dev, "weekly_report", report_summary(report))
    return {"queued": len(notified), "notified": notified, "delivered": False, "channel": "outbox"}


@router.get("/caregiver/reports/weekly", response_model=WeeklyReport)
def caregiver_weekly_report(
    senior_device_id: str | None = None,
    locale: str = Query("zh-CN"),
    principal: Principal = Depends(current_principal),
) -> WeeklyReport:
    """Read a bound senior's report (family auth + pairing check)."""
    device = linked_device(principal, senior_device_id)
    return build_weekly_report(device, store, locale=_locale(locale))


@router.get("/caregiver/reports/weekly.html", response_class=HTMLResponse)
def caregiver_weekly_report_html(
    senior_device_id: str | None = None,
    locale: str = Query("zh-CN"),
    principal: Principal = Depends(current_principal),
) -> HTMLResponse:
    device = linked_device(principal, senior_device_id)
    return HTMLResponse(render_html(build_weekly_report(device, store, locale=_locale(locale))))
