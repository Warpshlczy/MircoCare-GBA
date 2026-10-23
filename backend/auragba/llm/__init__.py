"""Optional LLM orchestration for the three 501-by-default contract routes.

The package deliberately has no imports in ``__init__`` so pure modules such as
``safety`` can be imported without pulling in ``httpx`` or a configured model.
"""
