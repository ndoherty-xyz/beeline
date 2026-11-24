"""Features and scoring for beeline's base model.

Mirrors packages/beeline/src/model.ts line for line; test/model.test.ts checks the two give the same scores on a fixture
written by train.py.
"""

import math

import numpy as np

# Pointer events stop while the cursor is still, so a gap this long between samples means it stopped.
STILL_GAP_MS = 40

MOTION_FEATURE_COUNT = 6
TARGET_FEATURE_COUNT = 9


# Features ----------


def find_sample_ago(times, current, age_ms):
    """Return the index of the newest sample at least age_ms older than sample `current`, or 0 if none is."""
    return max(0, int(np.searchsorted(times[: current + 1], times[current] - age_ms, side="right")) - 1)


def compute_motion_features(times, xs, ys, current):
    """Describe the cursor's motion up to sample `current`.

    Returns the motion features and the unit heading (hx, hy) that target features are measured along.
    """
    at50 = find_sample_ago(times, current, 50)
    at150 = find_sample_ago(times, current, 150)
    at400 = find_sample_ago(times, current, 400)
    recent_x = xs[current] - xs[at50]
    recent_y = ys[current] - ys[at50]
    earlier_x = xs[at50] - xs[at150]
    earlier_y = ys[at50] - ys[at150]
    recent_length = math.hypot(recent_x, recent_y)
    earlier_length = math.hypot(earlier_x, earlier_y)
    longer_length = math.hypot(xs[current] - xs[at400], ys[current] - ys[at400])

    heading = (1.0, 0.0)
    if recent_length > 0:
        heading = (recent_x / recent_length, recent_y / recent_length)
    elif longer_length > 0:
        heading = ((xs[current] - xs[at400]) / longer_length, (ys[current] - ys[at400]) / longer_length)

    turn_cos, turn_sin = 1.0, 0.0
    if recent_length > 0 and earlier_length > 0:
        turn_cos = (earlier_x * recent_x + earlier_y * recent_y) / (earlier_length * recent_length)
        turn_sin = (earlier_x * recent_y - earlier_y * recent_x) / (earlier_length * recent_length)

    onset = current
    while onset > 0 and times[onset] - times[onset - 1] <= STILL_GAP_MS:
        onset -= 1

    motion_features = [
        math.log1p(recent_length / 50),
        math.log1p(earlier_length / 100),
        turn_cos,
        turn_sin,
        math.log1p(longer_length),
        math.log1p(times[current] - times[onset]),
    ]
    return motion_features, heading


def compute_target_features(cursor_x, cursor_y, heading, rects):
    """Describe each target relative to the cursor, in the frame of its heading.

    rects is an (N, 4) array of [left, top, right, bottom]; returns an (N, TARGET_FEATURE_COUNT) array.
    """
    hx, hy = heading
    left, top, right, bottom = rects[:, 0], rects[:, 1], rects[:, 2], rects[:, 3]
    nearest_distance = np.hypot(
        np.minimum(np.maximum(cursor_x, left), right) - cursor_x,
        np.minimum(np.maximum(cursor_y, top), bottom) - cursor_y,
    )
    center_x = (left + right) / 2 - cursor_x
    center_y = (top + bottom) / 2 - cursor_y
    center_distance = np.hypot(center_x, center_y)
    center_along = center_x * hx + center_y * hy
    center_across = center_y * hx - center_x * hy

    corners_x = np.stack([left - cursor_x, left - cursor_x, right - cursor_x, right - cursor_x])
    corners_y = np.stack([top - cursor_y, bottom - cursor_y, top - cursor_y, bottom - cursor_y])
    across = corners_y * hx - corners_x * hy
    along = corners_x * hx + corners_y * hy
    lateral_gap = np.maximum(0, np.maximum(across.min(axis=0), -across.max(axis=0)))
    behind_gap = np.maximum(0, -along.max(axis=0))

    return np.stack(
        [
            np.log1p(nearest_distance),
            (nearest_distance == 0).astype(np.float64),
            center_along / (center_distance + 1),
            center_across / (center_distance + 1),
            np.log1p(center_distance),
            np.log1p(lateral_gap),
            np.log1p(behind_gap),
            np.log1p(right - left),
            np.log1p(bottom - top),
        ],
        axis=1,
    )


def compute_features(times, xs, ys, current, rects):
    """Return the (N, feature count) model input for every target at sample `current`."""
    motion_features, heading = compute_motion_features(times, xs, ys, current)
    target_features = compute_target_features(xs[current], ys[current], heading, rects)
    return np.hstack([np.tile(motion_features, (len(rects), 1)), target_features])


# Scoring ----------


def score_targets(weights, features):
    """Score each row of features with exported weights (a dict as in packages/beeline/src/model-weights.json)."""
    hidden = np.maximum(0, features @ np.asarray(weights["hiddenWeights"]).T + np.asarray(weights["hiddenBiases"]))
    return hidden @ np.asarray(weights["outputWeights"])


def predict_probabilities(weights, features):
    """Return each target's chance of a click within weights["withinMs"]: a softmax over the targets and the none option."""
    none_score = weights["noneBias"] + features[0, :MOTION_FEATURE_COUNT] @ np.asarray(weights["noneWeights"])
    scores = np.append(score_targets(weights, features), none_score)
    exponentials = np.exp(scores - scores.max())
    return (exponentials / exponentials.sum())[:-1]
