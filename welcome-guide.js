/**
 * Hibiscus Studio — Welcome Guide popup
 *
 * A self-contained, dependency-free modal that shows the client welcome guide.
 * Include it on any page with:
 *
 *   <script src="/welcome-guide.js"></script>
 *
 * then call `showWelcomeGuide()` at the moment you want it to appear
 * (e.g. after a booking is confirmed, or after the client looks up their
 * booking in the portal).
 *
 * The modal injects its own scoped CSS (all rules are prefixed with `.hbs-wg`)
 * so it does not clash with the host page's styles, and it works on both light
 * and dark host pages.
 */
(function () {
  'use strict';

  var STYLE_ID = 'hbs-wg-style';
  var OVERLAY_ID = 'hbs-wg-overlay';
  var lastFocused = null;

  var CSS = [
    '.hbs-wg-overlay{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(20,18,16,0.6);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);opacity:0;transition:opacity .2s ease}',
    '.hbs-wg-overlay.is-open{opacity:1}',
    '.hbs-wg-dialog{position:relative;width:100%;max-width:760px;max-height:88vh;display:flex;flex-direction:column;background:#fefdfb;color:#1c1917;border-radius:22px;box-shadow:0 30px 80px rgba(0,0,0,0.35);transform:translateY(12px) scale(.98);transition:transform .2s ease;overflow:hidden}',
    '.hbs-wg-overlay.is-open .hbs-wg-dialog{transform:none}',
    '.hbs-wg-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:24px 24px 18px;border-bottom:1px solid #e8e3da}',
    '.hbs-wg-header h2{margin:0;font-family:Georgia,"Times New Roman",serif;font-weight:400;font-size:1.7rem;line-height:1.1;color:#1c1917}',
    '.hbs-wg-header p{margin:6px 0 0;color:#6b6560;font-size:.9rem;line-height:1.5}',
    '.hbs-wg-close{flex-shrink:0;width:38px;height:38px;border-radius:50%;border:1px solid #e8e3da;background:#fff;color:#1c1917;font-size:20px;line-height:1;cursor:pointer;display:grid;place-items:center;transition:background .15s ease,border-color .15s ease}',
    '.hbs-wg-close:hover{background:#fdf2f4;border-color:rgba(190,77,94,.3)}',
    '.hbs-wg-body{overflow-y:auto;padding:22px 24px}',
    '.hbs-wg-grid{display:grid;grid-template-columns:1fr;gap:14px}',
    '@media (min-width:640px){.hbs-wg-grid{grid-template-columns:1fr 1fr}}',
    '.hbs-wg-card{border:1px solid #e8e3da;border-radius:16px;padding:16px 18px;background:linear-gradient(180deg,rgba(0,0,0,0.015),transparent)}',
    '.hbs-wg-card h3{margin:0 0 10px;font-family:Georgia,"Times New Roman",serif;font-weight:400;font-size:1.25rem;color:#1c1917}',
    '.hbs-wg-card p{margin:0 0 10px;color:#44403c;font-size:.88rem;line-height:1.6}',
    '.hbs-wg-card p:last-child{margin-bottom:0}',
    '.hbs-wg-card ul{margin:0 0 10px;padding-left:18px}',
    '.hbs-wg-card ul:last-child{margin-bottom:0}',
    '.hbs-wg-card li{margin-bottom:6px;color:#44403c;font-size:.88rem;line-height:1.55}',
    '.hbs-wg-card li:last-child{margin-bottom:0}',
    '.hbs-wg-card li strong{color:#1c1917}',
    '.hbs-wg-note{margin-top:12px;padding:10px 12px;border-radius:12px;background:#fff5e8;color:#44403c;font-size:.84rem;line-height:1.5}',
    '.hbs-wg-contact{margin-top:12px;padding:12px 14px;border-radius:12px;background:#fdf2f4;color:#44403c;font-size:.84rem;line-height:1.5}',
    '.hbs-wg-contact strong{display:block;margin:2px 0;color:#be4d5e;font-size:1.05rem}',
    '.hbs-wg-footer{padding:16px 24px;border-top:1px solid #e8e3da;display:flex;justify-content:center;background:#fefdfb}',
    '.hbs-wg-footer button{border:none;background:#be4d5e;color:#fff;font:inherit;font-weight:700;font-size:.9rem;padding:12px 26px;border-radius:999px;cursor:pointer;transition:transform .15s ease,background .15s ease}',
    '.hbs-wg-footer button:hover{background:#a8434f;transform:translateY(-1px)}',
    '@media (max-width:640px){.hbs-wg-header{padding:20px 18px 14px}.hbs-wg-body{padding:18px}.hbs-wg-footer{padding:14px 18px}}'
  ].join('\n');

  var CONTENT = [
    '<div class="hbs-wg-grid">',

    '<article class="hbs-wg-card">',
    '<h3>Arrival &amp; access</h3>',
    '<p>Your studio assistant will be on site at the start of your booking. Please check in with them within the first 30 minutes and complete a brief walkthrough of the space together. The walkthrough confirms the condition of the venue before your event begins &mdash; it protects you and ensures everything is ready.</p>',
    '<p>As the lead booker, you are responsible for the condition of the space and the behaviour of all guests you bring into the studio.</p>',
    '<p>If you are working with decorators, photographers, caterers or stylists:</p>',
    '<ul>',
    '<li><strong>Let us know before your event</strong> &mdash; all vendors must be declared ahead of your booking date.</li>',
    '<li><strong>No early access</strong> &mdash; vendors must arrive at the start of your booked time, under any circumstances.</li>',
    '<li><strong>Respectful conduct required</strong> &mdash; pressuring behaviour about early access will not be tolerated.</li>',
    '<li><strong>All decor cleared before your booking ends</strong> &mdash; vendor setup and breakdown is your responsibility as the lead booker.</li>',
    '</ul>',
    '<div class="hbs-wg-contact"><span>Contact during your booking</span><strong>07984 051064</strong><span>Call us if you need anything during your hire.</span></div>',
    '</article>',

    '<article class="hbs-wg-card">',
    '<h3>What&rsquo;s included</h3>',
    '<p>Every hire includes exclusive use of the full studio, plus:</p>',
    '<ul>',
    '<li>Approx 1,000 sq ft blank canvas</li>',
    '<li>40 chairs and 10 tables</li>',
    '<li>High-speed WiFi and a Bluetooth speaker</li>',
    '<li>Private facilities</li>',
    '<li>2 bin bags and light cleaning products</li>',
    '<li>Feminine hygiene products in the facilities</li>',
    '</ul>',
    '<p>Please bring your own:</p>',
    '<ul>',
    '<li>Decorations, tablecloths and linens</li>',
    '<li>Glassware and catering supplies</li>',
    '<li>Additional rubbish bags</li>',
    '</ul>',
    '</article>',

    '<article class="hbs-wg-card">',
    '<h3>Venue rules</h3>',
    '<ul>',
    '<li><strong>Walls and surfaces.</strong> No tape, Blu Tack, adhesive hooks, nails or screws on any walls or surfaces.</li>',
    '<li><strong>Floors.</strong> Tables must be lifted, not dragged. Protect the floor from paint, dye, food colouring and staining materials.</li>',
    '<li><strong>Candles.</strong> Permitted in glass holders only. Open flames are not allowed.</li>',
    '<li><strong>Confetti and glitter.</strong> Permitted but must be fully cleaned before departure.</li>',
    '<li><strong>CCTV.</strong> The studio and entrance are monitored by CCTV at all times.</li>',
    '<li><strong>Rubbish.</strong> Bags must be ready and placed by the door 30 minutes before your booking ends. Rubbish found outside the studio or in other bins results in a &pound;50 deduction from your deposit.</li>',
    '</ul>',
    '<p>Music &amp; sound:</p>',
    '<ul>',
    '<li>All music and sound must finish by <strong>10:00 PM</strong>. No exceptions.</li>',
    '<li><strong>DJs are welcome</strong> &mdash; a supervision fee of &pound;95 applies and must be paid in advance.</li>',
    '<li>DJs must bring their own speakers and PA system; the studio Bluetooth speaker is not available for DJ use.</li>',
    '<li>Sound levels must remain considerate of the surrounding building and neighbourhood at all times.</li>',
    '</ul>',
    '</article>',

    '<article class="hbs-wg-card">',
    '<h3>Kitchen</h3>',
    '<p>The kitchen is fully equipped with appliances:</p>',
    '<ul>',
    '<li>5-hob induction stove</li>',
    '<li>Double oven and microwave</li>',
    '<li>Fridge</li>',
    '<li>Kettle and toaster</li>',
    '<li>Sink</li>',
    '</ul>',
    '<p>We do not supply cooking utensils, pots and pans, plates and cutlery, ingredients, or washing up liquid &mdash; please bring your own.</p>',
    '<div class="hbs-wg-note">Outside catering is welcome. Deep fat fryers are not permitted.</div>',
    '</article>',

    '<article class="hbs-wg-card">',
    '<h3>Parking</h3>',
    '<p>Street parking is available on nearby roads. Please check signage for any restrictions before leaving your vehicle.</p>',
    '<ul>',
    '<li><strong>Peto Street North</strong> &mdash; drop off &amp; unloading only</li>',
    '<li><strong>Caxton Street North</strong> &mdash; parking available</li>',
    '<li><strong>Heartwell Avenue</strong> &mdash; parking available</li>',
    '<li><strong>Hoy Street</strong> &mdash; parking available</li>',
    '<li><strong>Fen Street</strong> &mdash; parking available</li>',
    '</ul>',
    '<div class="hbs-wg-note">Free parking after 6:30 PM and all day on Sundays.</div>',
    '</article>',

    '<article class="hbs-wg-card">',
    '<h3>Timings &amp; pack-down</h3>',
    '<ul>',
    '<li><strong>Setup and pack-down</strong> are included within your booked time. Please plan your day accordingly.</li>',
    '<li><strong>A 10-minute grace period</strong> applies at the end of your booking. After this, a late fee of &pound;50 per 30 minutes applies.</li>',
    '<li><strong>Additional hours</strong> can be requested subject to availability at &pound;100 per hour.</li>',
    '</ul>',
    '<p>Before you go, please:</p>',
    '<ul>',
    '<li>Ask guests not to gather outside once your booking has ended, and keep noise to a minimum on arrival and departure.</li>',
    '<li>Empty remaining liquids, double-bag heavy rubbish, and place all tied bags in the collection area 30 minutes before your booking ends.</li>',
    '<li>Wipe down tables, worktops and kitchen surfaces, and sweep and mop the floor (hoover, mop, bucket and cleaning supplies are provided).</li>',
    '<li>Return all furniture to its original position, remove all decor and vendor items, and switch off the speaker.</li>',
    '<li>Let your studio assistant know you are ready to leave so the inspection can begin.</li>',
    '</ul>',
    '</article>',

    '<article class="hbs-wg-card">',
    '<h3>Deposit return</h3>',
    '<p>Your &pound;200 damages deposit is returned within 1&ndash;3 working days following inspection of the studio.</p>',
    '<div class="hbs-wg-note">Please leave the studio in the same clean and tidy condition in which it was found. Damage beyond normal use, or rubbish left outside the studio, may result in a deduction from your deposit.</div>',
    '</article>',

    '</div>'
  ].join('');

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.appendChild(document.createTextNode(CSS));
    document.head.appendChild(style);
  }

  function buildOverlay() {
    var overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'hbs-wg-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'hbs-wg-title');
    overlay.innerHTML =
      '<div class="hbs-wg-dialog">' +
        '<div class="hbs-wg-header">' +
          '<div>' +
            '<h2 id="hbs-wg-title">Welcome to Hibiscus Studio</h2>' +
            '<p>Everything you need to know about your visit &mdash; arrival, what&rsquo;s included, the studio rules, and how to leave the space ready for the next guest.</p>' +
          '</div>' +
          '<button class="hbs-wg-close" type="button" aria-label="Close welcome guide">&times;</button>' +
        '</div>' +
        '<div class="hbs-wg-body">' + CONTENT + '</div>' +
        '<div class="hbs-wg-footer">' +
          '<button class="hbs-wg-confirm" type="button">Got it &mdash; enjoy your event</button>' +
        '</div>' +
      '</div>';
    return overlay;
  }

  function close() {
    var overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    overlay.classList.remove('is-open');
    document.removeEventListener('keydown', onKeydown, true);
    if (document.body) document.body.style.overflow = '';
    // Remove after the fade-out transition.
    setTimeout(function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 220);
    if (lastFocused && typeof lastFocused.focus === 'function') {
      lastFocused.focus();
    }
  }

  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }

  function showWelcomeGuide() {
    if (document.getElementById(OVERLAY_ID)) {
      // Already open — just bring it to the front.
      document.getElementById(OVERLAY_ID).classList.add('is-open');
      return;
    }
    ensureStyle();
    lastFocused = document.activeElement;
    var overlay = buildOverlay();
    document.body.appendChild(overlay);

    // Trigger the open transition on the next frame.
    requestAnimationFrame(function () {
      overlay.classList.add('is-open');
    });

    if (document.body) document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeydown, true);

    overlay.querySelector('.hbs-wg-close').addEventListener('click', close);
    overlay.querySelector('.hbs-wg-confirm').addEventListener('click', close);
    // Click on the backdrop (but not the dialog) closes it.
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });

    var closeBtn = overlay.querySelector('.hbs-wg-close');
    if (closeBtn) closeBtn.focus();
  }

  // Expose for host pages.
  window.showWelcomeGuide = showWelcomeGuide;
})();
