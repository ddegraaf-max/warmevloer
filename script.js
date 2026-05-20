// mijnwarmevloer.nl — Shared scripts

// Mark JS-enabled so reveal animations activate (CSS hides .reveal only when this is set)
document.documentElement.classList.add('js-enabled');

document.addEventListener('DOMContentLoaded', () => {
  // Nav scroll state
  const nav = document.getElementById('nav');
  if (nav) {
    const setNavState = () => nav.classList.toggle('scrolled', window.scrollY > 20);
    window.addEventListener('scroll', setNavState);
    setNavState();
  }

  // Reveal on scroll
  const reveals = document.querySelectorAll('.reveal');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.05, rootMargin: '0px 0px -10px 0px' });
  reveals.forEach(el => observer.observe(el));

  // Fallback: reveal any in-viewport elements after page settles
  requestAnimationFrame(() => {
    setTimeout(() => {
      reveals.forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.top < window.innerHeight && r.bottom > 0) {
          el.classList.add('visible');
        }
      });
    }, 100);
  });

  // Mobile menu toggle
  const navToggle = document.getElementById('navToggle');
  const navMenu = document.getElementById('navMenu');
  if (navToggle && navMenu) {
    navToggle.addEventListener('click', () => {
      navMenu.classList.toggle('mobile-open');
    });
  }
});
