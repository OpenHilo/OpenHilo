"""Return the arithmetic mean; reject an empty sequence with ValueError."""


def average(values):
    # Intentional bug for the repair example: flooring loses the fractional part.
    return sum(values) // len(values)
