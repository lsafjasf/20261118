from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Template:
    timescale: int = 1
    presentation_time_offset: int = 0
    start_number: int = 1
    duration_ticks: int | None = None
    media: str | None = None
    initialization: str | None = None
    sap_type: int | None = None


@dataclass
class Segment:
    number: int
    media_time: int
    duration_ticks: int
    url: str
    period_relative_s: float
    duration_s: float
    presentation_start_s: float
    presentation_end_s: float
    is_empty: bool = False
    sap_type: int | None = None

    @property
    def starts_with_keyframe(self) -> bool:
        # SAP types 1-3 mean the segment starts with a stream access point.
        return self.sap_type is not None and 1 <= self.sap_type <= 3


@dataclass
class Representation:
    id: str
    period_id: str
    template: Template
    segments: list[Segment] = field(default_factory=list)


@dataclass
class Period:
    id: str
    start_s: float
    duration_s: float | None
    representations: list[Representation] = field(default_factory=list)

    @property
    def end_s(self) -> float:
        if self.duration_s is None:
            return self.start_s
        return self.start_s + self.duration_s


@dataclass
class Manifest:
    path: str
    media_presentation_duration_s: float | None
    periods: list[Period]

    @property
    def last_period_end_s(self) -> float:
        return max((period.end_s for period in self.periods), default=0.0)


@dataclass
class Issue:
    code: str
    severity: str
    message: str
    detail: dict = field(default_factory=dict)

    def as_row(self) -> list[str]:
        return [
            self.severity,
            self.code,
            self.detail.get("period", "-"),
            self.detail.get("representation", "-"),
            self.message,
        ]
