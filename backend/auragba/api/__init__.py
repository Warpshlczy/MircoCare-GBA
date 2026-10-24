"""API layer (FastAPI routers)."""

from .contract_routes import router as contract_router
from .insight_routes import router as insight_router
from .auth_routes import router as auth_router
from .caregiver_routes import router as caregiver_router
from .report_routes import router as report_router

__all__ = ["auth_router", "caregiver_router", "contract_router", "insight_router", "report_router"]