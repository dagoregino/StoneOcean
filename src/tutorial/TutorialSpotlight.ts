import './tutorial.css';

export interface RectLike {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Placement {
  top: number;
  left: number;
  arrowSide: 'top' | 'bottom' | 'left' | 'right';
}

/** Union bounding box of a list of elements. Null if empty. */
export function unionRect(elements: readonly Element[]): DOMRect | null {
  if (elements.length === 0) return null;
  let top = Infinity;
  let left = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const el of elements) {
    const r = el.getBoundingClientRect();
    top = Math.min(top, r.top);
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  return new DOMRect(left, top, right - left, bottom - top);
}

/** Pure placement: keep the card inside the viewport. */
export function placeCard(
  target: RectLike | null,
  cardSize: { width: number; height: number },
  viewportSize: { width: number; height: number },
  preferred: 'top' | 'bottom' | 'left' | 'right' | 'auto',
): Placement {
  const margin = 12;
  const vw = viewportSize.width;
  const vh = viewportSize.height;
  const cw = cardSize.width;
  const ch = cardSize.height;

  if (!target) {
    return { top: (vh - ch) / 2, left: (vw - cw) / 2, arrowSide: 'bottom' };
  }

  const tcx = target.left + target.width / 2;
  const tcy = target.top + target.height / 2;

  // Try preferred side first, then fall back.
  const order: Array<'bottom' | 'top' | 'right' | 'left'> =
    preferred === 'auto' ? ['bottom', 'top', 'right', 'left'] : [preferred as 'bottom' | 'top' | 'right' | 'left', 'bottom', 'top', 'right', 'left'];

  for (const side of order) {
    let top = 0;
    let left = 0;
    let ok = true;
    if (side === 'bottom') {
      top = target.top + target.height + margin;
      left = tcx - cw / 2;
      if (top + ch > vh - margin) ok = false;
    } else if (side === 'top') {
      top = target.top - ch - margin;
      left = tcx - cw / 2;
      if (top < margin) ok = false;
    } else if (side === 'right') {
      top = tcy - ch / 2;
      left = target.left + target.width + margin;
      if (left + cw > vw - margin) ok = false;
    } else {
      top = tcy - ch / 2;
      left = target.left - cw - margin;
      if (left < margin) ok = false;
    }
    left = Math.max(margin, Math.min(left, vw - cw - margin));
    top = Math.max(margin, Math.min(top, vh - ch - margin));
    if (ok) return { top, left, arrowSide: side === 'bottom' ? 'top' : side === 'top' ? 'bottom' : side === 'right' ? 'left' : 'right' };
  }
  return { top: Math.max(margin, (vh - ch) / 2), left: Math.max(margin, (vw - cw) / 2), arrowSide: 'bottom' };
}

export class TutorialSpotlight {
  private layer: HTMLElement;
  private hole: HTMLElement;
  private card: HTMLElement;
  private arrow: HTMLElement;
  private resizeHandler: () => void;
  private scrollHandler: () => void;

  constructor() {
    this.layer = document.createElement('div');
    this.layer.className = 'tut-layer';
    this.hole = document.createElement('div');
    this.hole.className = 'tut-hole';
    this.card = document.createElement('div');
    this.card.className = 'tut-card';
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-live', 'polite');
    this.arrow = document.createElement('div');
    this.arrow.className = 'tut-arrow';
    this.card.append(this.arrow);

    document.body.append(this.layer, this.hole, this.card);

    this.resizeHandler = () => this.reposition();
    this.scrollHandler = () => this.reposition();
    window.addEventListener('resize', this.resizeHandler);
    window.addEventListener('scroll', this.scrollHandler, true);
  }

  setTarget(elements: readonly Element[] | null): void {
    const rect = elements ? unionRect(elements) : null;
    if (rect) {
      this.hole.style.top = `${rect.top}px`;
      this.hole.style.left = `${rect.left}px`;
      this.hole.style.width = `${rect.width}px`;
      this.hole.style.height = `${rect.height}px`;
      this.hole.style.display = 'block';
    } else {
      this.hole.style.display = 'none';
    }
    this.reposition(rect);
  }

  setCard(content: HTMLElement): void {
    // Remove old content except arrow
    for (const child of Array.from(this.card.children)) {
      if (child !== this.arrow) child.remove();
    }
    this.card.append(content);
  }

  private reposition(rect?: DOMRect | null): void {
    const r = rect ?? (this.hole.style.display !== 'none' ? new DOMRect(parseFloat(this.hole.style.left), parseFloat(this.hole.style.top), parseFloat(this.hole.style.width), parseFloat(this.hole.style.height)) : null);
    const cardRect = this.card.getBoundingClientRect();
    const placement = placeCard(r, { width: cardRect.width || 320, height: cardRect.height || 160 }, { width: window.innerWidth, height: window.innerHeight }, 'auto');
    this.card.style.top = `${placement.top}px`;
    this.card.style.left = `${placement.left}px`;
  }

  announce(text: string): void {
    this.card.setAttribute('aria-label', text);
  }

  destroy(): void {
    window.removeEventListener('resize', this.resizeHandler);
    window.removeEventListener('scroll', this.scrollHandler, true);
    this.layer.remove();
    this.hole.remove();
    this.card.remove();
  }
}