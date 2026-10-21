"""Stock levels for warehouse items."""


def units_on_hand(received: int, shipped: int) -> int:
    """Return the units left after shipments."""
    return received - shipped
