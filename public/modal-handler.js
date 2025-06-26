// modal-handler.js

// Luk modal ved klik udenfor indhold
document.querySelectorAll('.modal').forEach(modal => {
  modal.addEventListener('click', e => {
    const wrapper = modal.querySelector('.modal-wrapper');
    if (!wrapper.contains(e.target)) {
      modal.style.display = "none";
      modal.classList.remove("show");
    }
  });
});

// Luk modal ved Escape-tast
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal').forEach(modal => {
      const visible = getComputedStyle(modal).display !== 'none';
      if (visible) {
        modal.style.display = 'none';
        modal.classList.remove("show");
      }
    });
  }
});