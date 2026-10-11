// antimatter.chat: the navigation bar turns solid once the page scrolls, the mobile menu opens, sections fade in,
// and screenshots open full size when clicked.
(function () {
    document.documentElement.classList.add('js');

    var nav = document.querySelector('.nav');
    if (nav && !document.body.classList.contains('plain')) {
        var onScroll = function () {
            nav.classList.toggle('solid', window.scrollY > 40);
        };
        onScroll();
        window.addEventListener('scroll', onScroll, {passive: true});
    }

    var toggle = document.querySelector('.nav-toggle');
    if (toggle) {
        toggle.addEventListener('click', function () {
            var open = nav.classList.toggle('open');
            toggle.setAttribute('aria-expanded', String(open));
        });
    }

    // The language menu closes on a click elsewhere.
    document.addEventListener('click', function (e) {
        document.querySelectorAll('details.lang[open]').forEach(function (d) {
            if (!d.contains(e.target)) {
                d.removeAttribute('open');
            }
        });
    });

    // Screenshots open full size in a lightbox; a click anywhere or Escape closes it.
    var box = null;
    var close = function () {
        if (box) {
            var closing = box;
            box = null;
            closing.classList.remove('open');
            document.body.classList.remove('lightbox-open');
            // Removed once faded out; at once if there's no transition (reduced motion).
            closing.addEventListener('transitionend', function () {
                closing.remove();
            });
            setTimeout(function () {
                closing.remove();
            }, 300);
        }
    };
    document.querySelectorAll('.frame img, .light-frame img').forEach(function (img) {
        img.classList.add('zoomable');
        img.setAttribute('tabindex', '0');
        img.setAttribute('role', 'button');
        var open = function () {
            box = document.createElement('div');
            box.className = 'lightbox';
            box.setAttribute('role', 'dialog');
            box.setAttribute('aria-label', img.alt);
            var big = document.createElement('img');
            big.src = img.currentSrc || img.src;
            big.alt = img.alt;
            box.appendChild(big);
            box.addEventListener('click', close);
            document.body.appendChild(box);
            document.body.classList.add('lightbox-open');
            var opening = box;
            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    opening.classList.add('open');
                });
            });
        };
        img.addEventListener('click', open);
        img.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                open();
            }
        });
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            close();
        }
    });

    if ('IntersectionObserver' in window) {
        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    entry.target.classList.add('in');
                    observer.unobserve(entry.target);
                }
            });
        }, {rootMargin: '0px 0px -60px 0px'});
        document.querySelectorAll('.reveal').forEach(function (el) {
            observer.observe(el);
        });
    } else {
        document.querySelectorAll('.reveal').forEach(function (el) {
            el.classList.add('in');
        });
    }
}());
