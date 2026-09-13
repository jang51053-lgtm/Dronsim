export class Joystick {
  constructor(zoneEl) {
    this.zoneEl = zoneEl;
    this.stickEl = zoneEl.querySelector('.joystick-stick');
    this.baseEl = zoneEl.querySelector('.joystick-base');
    this.active = false;
    this.pointerId = null;
    this.x = 0;
    this.y = 0;

    zoneEl.addEventListener('pointerdown', this.onDown.bind(this));
    window.addEventListener('pointermove', this.onMove.bind(this));
    window.addEventListener('pointerup', this.onUp.bind(this));
    window.addEventListener('pointercancel', this.onUp.bind(this));
  }

  onDown(e) {
    if (this.active) return;
    this.active = true;
    this.pointerId = e.pointerId;
    this.zoneEl.setPointerCapture?.(e.pointerId);
    this.updateFromEvent(e);
  }

  onMove(e) {
    if (!this.active || e.pointerId !== this.pointerId) return;
    this.updateFromEvent(e);
  }

  onUp(e) {
    if (!this.active || e.pointerId !== this.pointerId) return;
    this.active = false;
    this.pointerId = null;
    this.x = 0;
    this.y = 0;
    this.stickEl.style.transform = 'translate(0px, 0px)';
  }

  updateFromEvent(e) {
    const rect = this.baseEl.getBoundingClientRect();
    const maxRadius = rect.width / 2 - 4;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > maxRadius) {
      dx = (dx / dist) * maxRadius;
      dy = (dy / dist) * maxRadius;
    }
    this.stickEl.style.transform = `translate(${dx}px, ${dy}px)`;
    this.x = dx / maxRadius;
    this.y = dy / maxRadius;
  }
}
