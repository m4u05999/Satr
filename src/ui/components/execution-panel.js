// إحالة توافقية للاسم القديم. غرفة العمليات هي مالك سير التنفيذ الوحيد الآن؛ إبقاء
// العنصر يمنع كسر أي استدعاء محلي قديم من دون إبقاء حالة أو بوابات منافسة.
class SatrExecutionPanel extends HTMLElement {
  open(cwd) {
    this.dispatchEvent(new CustomEvent('ops-room-open', {
      bubbles: true,
      detail: { cwd: typeof cwd === 'string' ? cwd : '' },
    }));
  }

  close() {
    this.removeAttribute('open');
  }

  handleEvent(event) {
    const room = document.querySelector('satr-ops-room');
    if (room && room.handleEvent) room.handleEvent(event);
  }
}

customElements.define('satr-execution-panel', SatrExecutionPanel);
