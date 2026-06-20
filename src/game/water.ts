export type Point = {
  x: number;
  y: number;
};

export type MovingWaterThing = Point & {
  vx: number;
  vy: number;
};

const WATER_POLYGON: Point[] = [
  { x: 210, y: 610 },
  { x: 320, y: 535 },
  { x: 500, y: 500 },
  { x: 720, y: 500 },
  { x: 940, y: 510 },
  { x: 1130, y: 530 },
  { x: 1250, y: 570 },
  { x: 1350, y: 650 },
  { x: 1550, y: 710 },
  { x: 1645, y: 785 },
  { x: 1580, y: 850 },
  { x: 1400, y: 910 },
  { x: 1160, y: 940 },
  { x: 890, y: 935 },
  { x: 620, y: 905 },
  { x: 390, y: 850 },
  { x: 220, y: 760 },
  { x: 155, y: 675 }
];

const DOCK_BLOCK_POLYGON: Point[] = [
  { x: 1190, y: 500 },
  { x: 1625, y: 520 },
  { x: 1625, y: 690 },
  { x: 1360, y: 690 },
  { x: 1295, y: 620 },
  { x: 1190, y: 595 }
];

const WATER_BOUNDS = {
  minX: Math.min(...WATER_POLYGON.map((point) => point.x)),
  maxX: Math.max(...WATER_POLYGON.map((point) => point.x)),
  minY: Math.min(...WATER_POLYGON.map((point) => point.y)),
  maxY: Math.max(...WATER_POLYGON.map((point) => point.y))
};

export function isWaterPoint(point: Point): boolean {
  return pointInPolygon(point, WATER_POLYGON) && !pointInPolygon(point, DOCK_BLOCK_POLYGON);
}

export function isDuckWaterPoint(point: Point): boolean {
  const samplePoints: Point[] = [
    point,
    { x: point.x - 44, y: point.y + 18 },
    { x: point.x + 44, y: point.y + 18 },
    { x: point.x - 34, y: point.y - 18 },
    { x: point.x + 34, y: point.y - 18 },
    { x: point.x, y: point.y + 34 }
  ];

  return samplePoints.every(isWaterPoint);
}

export function randomWaterPoint(): Point {
  for (let attempts = 0; attempts < 250; attempts += 1) {
    const point = {
      x: WATER_BOUNDS.minX + Math.random() * (WATER_BOUNDS.maxX - WATER_BOUNDS.minX),
      y: WATER_BOUNDS.minY + Math.random() * (WATER_BOUNDS.maxY - WATER_BOUNDS.minY)
    };
    if (isWaterPoint(point)) return point;
  }

  return { x: 820, y: 705 };
}

export function randomDuckWaterPoint(): Point {
  for (let attempts = 0; attempts < 350; attempts += 1) {
    const point = randomWaterPoint();
    if (isDuckWaterPoint(point)) return point;
  }

  return { x: 820, y: 720 };
}

export function moveWithinWater<T extends MovingWaterThing>(thing: T, dt: number): void {
  const next = {
    x: thing.x + thing.vx * dt,
    y: thing.y + thing.vy * dt
  };

  if (isWaterPoint(next)) {
    thing.x = next.x;
    thing.y = next.y;
    return;
  }

  const horizontal = { x: thing.x + thing.vx * dt, y: thing.y };
  const vertical = { x: thing.x, y: thing.y + thing.vy * dt };

  if (isWaterPoint(horizontal)) {
    thing.x = horizontal.x;
    thing.vy *= -1;
  } else if (isWaterPoint(vertical)) {
    thing.y = vertical.y;
    thing.vx *= -1;
  } else {
    thing.vx *= -1;
    thing.vy *= -1;
  }

  if (!isWaterPoint(thing)) {
    const safe = randomWaterPoint();
    thing.x = safe.x;
    thing.y = safe.y;
  }
}

export function moveDuckWithinWater<T extends MovingWaterThing>(thing: T, dt: number): void {
  const next = {
    x: thing.x + thing.vx * dt,
    y: thing.y + thing.vy * dt
  };

  if (isDuckWaterPoint(next)) {
    thing.x = next.x;
    thing.y = next.y;
    return;
  }

  const horizontal = { x: thing.x + thing.vx * dt, y: thing.y };
  const vertical = { x: thing.x, y: thing.y + thing.vy * dt };

  if (isDuckWaterPoint(horizontal)) {
    thing.x = horizontal.x;
    thing.vy *= -1;
  } else if (isDuckWaterPoint(vertical)) {
    thing.y = vertical.y;
    thing.vx *= -1;
  } else {
    thing.vx *= -1;
    thing.vy *= -1;
  }

  if (!isDuckWaterPoint(thing)) {
    const safe = randomDuckWaterPoint();
    thing.x = safe.x;
    thing.y = safe.y;
  }
}

export function clampToWater(point: Point): Point {
  if (isWaterPoint(point)) return point;

  let best = randomWaterPoint();
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let attempts = 0; attempts < 500; attempts += 1) {
    const candidate = randomWaterPoint();
    const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;

  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const crossesY = currentPoint.y > point.y !== previousPoint.y > point.y;
    if (!crossesY) continue;

    const xAtY =
      ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) / (previousPoint.y - currentPoint.y) + currentPoint.x;
    if (point.x < xAtY) inside = !inside;
  }

  return inside;
}
