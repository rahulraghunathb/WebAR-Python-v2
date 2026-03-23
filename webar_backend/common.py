import logging
import sys
from collections import Counter
from datetime import datetime
from time import time


class MillisecondFormatter(logging.Formatter):
    default_msec_format = "%s.%03d"

    def formatTime(self, record, datefmt=None):
        dt = datetime.fromtimestamp(record.created)
        if datefmt:
            return dt.strftime(datefmt) + f".{int(record.msecs):03d}"
        return dt.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def create_backend_logger():
    logger = logging.getLogger("webar.backend")
    if logger.handlers:
        return logger

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        MillisecondFormatter(
            "%(asctime)s | %(levelname)s | backend | %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    logger.setLevel(logging.INFO)
    logger.addHandler(handler)
    logger.propagate = False
    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    return logger


def format_fields(**fields):
    parts = []
    for key, value in fields.items():
        if value is None:
            continue
        parts.append(f"{key}={value}")
    return " ".join(parts)


def log_event(logger, event, **fields):
    suffix = format_fields(**fields)
    if suffix:
        logger.info("%s %s", event, suffix)
        return
    logger.info("%s", event)


def rounded_metric(value, digits=3):
    try:
        return f"{float(value):.{digits}f}"
    except (TypeError, ValueError):
        return None


def iso_timestamp(timestamp=None):
    value = time() if timestamp is None else timestamp
    return datetime.fromtimestamp(value).isoformat(timespec="milliseconds")


def coerce_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def coerce_float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def coerce_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return False


def max_int_metric(events, field):
    return max((coerce_int(event.get(field), 0) for event in events), default=0)


def max_float_metric(events, field, digits=3, ignore_zero=False):
    values = [coerce_float(event.get(field), 0.0) for event in events]
    if ignore_zero:
        values = [value for value in values if value > 0]
    if not values:
        return 0
    return round(max(values), digits)


def average_float_metric(events, field, digits=3, ignore_zero=False):
    values = [coerce_float(event.get(field), 0.0) for event in events]
    if ignore_zero:
        values = [value for value in values if value > 0]
    if not values:
        return 0
    return round(sum(values) / len(values), digits)


def most_common_text(events, field, fallback="-"):
    values = [str(event.get(field, fallback) or fallback) for event in events]
    filtered = [value for value in values if value not in {"", "-", "None"}]
    if not filtered:
        return fallback
    return Counter(filtered).most_common(1)[0][0]


def most_common_text_excluding(events, field, excluded=None, fallback="-"):
    excluded_values = set(excluded or [])
    values = [str(event.get(field, fallback) or fallback) for event in events]
    filtered = [
        value
        for value in values
        if value not in {"", "-", "None"} and value not in excluded_values
    ]
    if not filtered:
        return fallback
    return Counter(filtered).most_common(1)[0][0]
