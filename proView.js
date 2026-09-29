import { trackPageview } from './analytics.mjs';

trackPageview();

document.querySelectorAll('.view-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.view-btn').forEach(function (b) {
      b.classList.remove('is-active');
    });
    btn.classList.add('is-active');

    var view = btn.dataset.view;

    document.getElementById('view-commercant').classList.toggle(
      'hidden',
      view !== 'commercant'
    );
    document.getElementById('view-technique').classList.toggle(
      'hidden',
      view !== 'technique'
    );
  });
});
