/**
 * Hibiscus Studio Booking Backend - Cloudflare Worker
 * Booking system with bank transfer confirmation
 */

import { Router } from 'itty-router';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const router = Router();

// ============================================
// CORS & Helpers
// ============================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Safe JSON parser that handles markdown-wrapped JSON (```json ... ```)
function safeJsonParse(str) {
  let cleaned = str.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-z]*\n?/, '');
    cleaned = cleaned.replace(/\n?```\s*$/, '');
  }
  return JSON.parse(cleaned.trim());
}

// Get current date/time in London timezone (not UTC, not user's local TZ)
function getLondonNow() {
  const now = new Date();
  const londonStr = now.toLocaleString('en-GB', { timeZone: 'Europe/London' });
  // Parse "DD/MM/YYYY, HH:MM:SS" back to Date
  const [datePart, timePart] = londonStr.split(', ');
  const [day, month, year] = datePart.split('/');
  const [hours, minutes, seconds] = timePart.split(':');
  return new Date(year, month - 1, day, hours, minutes, seconds);
}

function getLondonToday() {
  const d = getLondonNow();
  d.setHours(0, 0, 0, 0);
  return d;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function html(content, status = 200) {
  return new Response(content, {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'text/html' },
  });
}

// Handle CORS preflight
router.options('*', () => new Response(null, { headers: corsHeaders }));

// ============================================
// Google Calendar Auth (Service Account)
// ============================================

async function getAccessToken(env) {
  const serviceAccount = safeJsonParse(env.GOOGLE_SERVICE_ACCOUNT_JSON);

  // Create JWT
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const encodedHeader = btoa(JSON.stringify(header)).replace(/=/g, '');
  const encodedClaim = btoa(JSON.stringify(claim)).replace(/=/g, '');
  const signatureInput = `${encodedHeader}.${encodedClaim}`;

  // Sign with private key
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(serviceAccount.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(signatureInput)
  );

  const encodedSignature = arrayBufferToBase64Url(signature);
  const jwt = `${signatureInput}.${encodedSignature}`;

  // Exchange JWT for access token
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenResponse.json();
  return tokenData.access_token;
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\n/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function arrayBufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ============================================
// Calendar Operations
// ============================================

const TIME_SLOTS = [
  { id: 'morning', label: '12:00 PM - 6:00 PM', start: '12:00', end: '18:00', surcharge: 0 },
  { id: 'afternoon', label: '2:00 PM - 8:00 PM', start: '14:00', end: '20:00', surcharge: 0 },
  { id: 'evening', label: '4:00 PM - 10:00 PM', start: '16:00', end: '22:00', surcharge: 0 },
  { id: 'latenight', label: '6:00 PM - 12:00 AM', start: '18:00', end: '00:00', surcharge: 50 },
];

// Helper to get time slot/duration label for display
function getTimeSlotLabel(booking) {
  // New format: use startTime/endTime with duration
  if (booking.startTime && booking.endTime) {
    const formatTime = (t) => {
      const [h] = t.split(':');
      const hour = parseInt(h);
      if (hour === 0 || hour === 24) return '12am';
      if (hour === 12) return '12pm';
      return hour > 12 ? `${hour - 12}pm` : `${hour}am`;
    };
    return `${formatTime(booking.startTime)} - ${formatTime(booking.endTime)} (${booking.duration}hrs)`;
  }

  // Legacy format: use timeSlot ID
  const slotId = typeof booking === 'string' ? booking : booking.timeSlot;
  const slot = TIME_SLOTS.find(s => s.id === slotId);
  return slot?.label || slotId || 'TBC';
}

async function checkAvailability(date, env, includeDebug = false, duration = null) {
  const accessToken = await getAccessToken(env);

  // Query both calendars for busy times
  const timeMin = `${date}T00:00:00Z`;
  const timeMax = `${date}T23:59:59Z`;

  const freeBusyResponse = await fetch(
    'https://www.googleapis.com/calendar/v3/freeBusy',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        timeMin,
        timeMax,
        items: [
          { id: env.GOOGLE_CALENDAR_ID_WRITE },
          { id: env.GOOGLE_CALENDAR_ID_READ },
        ],
      }),
    }
  );

  const freeBusyData = await freeBusyResponse.json();

  // Check BOTH calendars - legacy bookings on READ calendar must be respected
  const writeCalBusy = freeBusyData.calendars?.[env.GOOGLE_CALENDAR_ID_WRITE]?.busy || [];
  const readCalBusy = freeBusyData.calendars?.[env.GOOGLE_CALENDAR_ID_READ]?.busy || [];
  const busyPeriods = [...writeCalBusy, ...readCalBusy];

  // Generate slots based on duration
  // If duration provided, generate hourly start-time slots for that duration
  // Otherwise, use the legacy 6-hour TIME_SLOTS
  const slotsToCheck = duration ? generateDurationSlots(duration) : TIME_SLOTS;

  // Check which slots are available
  const availableSlots = slotsToCheck.map(slot => {
    const slotStart = new Date(`${date}T${slot.start}:00`);
    let slotEnd;
    if (slot.end === '00:00') {
      const nextDay = new Date(date);
      nextDay.setDate(nextDay.getDate() + 1);
      slotEnd = new Date(`${nextDay.toISOString().split('T')[0]}T00:00:00`);
    } else {
      slotEnd = new Date(`${date}T${slot.end}:00`);
    }

    const isAvailable = !busyPeriods.some(busy => {
      const busyStart = new Date(busy.start);
      const busyEnd = new Date(busy.end);
      return slotStart < busyEnd && slotEnd > busyStart;
    });

    return { ...slot, available: isAvailable };
  });

  // B1: Tuesday constraint — Rochelle's daughter pickup means only 14:00-16:00 is valid
  const dayOfWeek = new Date(date + 'T12:00:00').getDay(); // noon avoids timezone edge
  const isTuesday = dayOfWeek === 2;
  const filteredSlots = isTuesday
    ? availableSlots.filter(s => {
        const endForCompare = s.end === '00:00' ? '24:00' : s.end;
        return s.start >= '14:00' && endForCompare <= '16:00';
      })
    : availableSlots;

  // Include debug info if requested
  if (includeDebug) {
    return { slots: filteredSlots, debug: { writeCalBusy, readCalBusy, isTuesday } };
  }
  return filteredSlots;
}

// Generate time slots for a given duration (in hours)
// Returns slots from 10am to midnight with the specified duration
function generateDurationSlots(duration) {
  const slots = [];
  const durationHours = parseInt(duration);
  // Start at 10am, last slot must end by midnight (24)
  const earliest = 10;
  const latest = 24 - durationHours;

  for (let startHour = earliest; startHour <= latest; startHour++) {
    const endHour = startHour + durationHours;
    const startStr = `${String(startHour).padStart(2, '0')}:00`;
    const endStr = endHour >= 24 ? '00:00' : `${String(endHour).padStart(2, '0')}:00`;

    const formatHour = (h) => {
      if (h === 0 || h === 24) return '12:00 AM';
      if (h === 12) return '12:00 PM';
      return h > 12 ? `${h - 12}:00 PM` : `${h}:00 AM`;
    };

    slots.push({
      id: `${startStr}-${endStr}`,
      label: `${formatHour(startHour)} - ${formatHour(endHour)} (${durationHours}h)`,
      start: startStr,
      end: endStr,
      surcharge: startHour >= 18 ? 50 : 0,
    });
  }
  return slots;
}

async function createProvisionalEvent(booking, env) {
  const accessToken = await getAccessToken(env);

  // Support new duration-based booking (startTime/endTime) or legacy timeSlot
  let startDateTime, endDateTime;

  if (booking.startTime && booking.endTime) {
    // New format: explicit start/end times from duration picker
    startDateTime = `${booking.date}T${booking.startTime}:00`;
    if (booking.endTime === '00:00' || booking.endTime === '24:00') {
      const nextDay = new Date(booking.date);
      nextDay.setDate(nextDay.getDate() + 1);
      endDateTime = `${nextDay.toISOString().split('T')[0]}T00:00:00`;
    } else {
      endDateTime = `${booking.date}T${booking.endTime}:00`;
    }
  } else {
    // Legacy format: use TIME_SLOTS lookup
    const slot = TIME_SLOTS.find(s => s.id === booking.timeSlot);
    startDateTime = `${booking.date}T${slot?.start || '12:00'}:00`;
    if (slot?.end === '00:00') {
      const nextDay = new Date(booking.date);
      nextDay.setDate(nextDay.getDate() + 1);
      endDateTime = `${nextDay.toISOString().split('T')[0]}T00:00:00`;
    } else {
      endDateTime = `${booking.date}T${slot?.end || '18:00'}:00`;
    }
  }

  const durationLabel = booking.duration ? `${booking.duration}hrs` : '';
  const event = {
    summary: `🟡 PENDING: ${booking.eventType} - ${booking.name}`,
    description: `
PROVISIONAL BOOKING - AWAITING PAYMENT

Customer: ${booking.name}
Email: ${booking.email}
Phone: ${booking.phone}
Event Type: ${booking.eventType}
Guests: ${booking.guestCount}
Duration: ${durationLabel}
Total: £${booking.total}
Deposit Due: £${booking.deposit}

Booking ID: ${booking.id}
    `.trim(),
    start: {
      dateTime: startDateTime,
      timeZone: 'Europe/London',
    },
    end: {
      dateTime: endDateTime,
      timeZone: 'Europe/London',
    },
    colorId: '5', // Yellow for pending
  };

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID_WRITE)}/events`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event),
    }
  );

  return response.json();
}

async function confirmEvent(calendarEventId, booking, env) {
  const accessToken = await getAccessToken(env);

  const event = {
    summary: `✅ CONFIRMED: ${booking.eventType} - ${booking.name}`,
    colorId: '2', // Green for confirmed
  };

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID_WRITE)}/events/${calendarEventId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event),
    }
  );

  return response.json();
}

async function deleteCalendarEvent(calendarEventId, env) {
  const accessToken = await getAccessToken(env);

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID_WRITE)}/events/${calendarEventId}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  return response.ok;
}

// Fetch all events from both calendars (for admin dashboard)
async function getAllCalendarEvents(env) {
  const accessToken = await getAccessToken(env);
  const now = new Date();
  const threeMonthsAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const sixMonthsAhead = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);

  const timeMin = threeMonthsAgo.toISOString();
  const timeMax = sixMonthsAhead.toISOString();

  const allEvents = [];
  const calendarIds = [env.GOOGLE_CALENDAR_ID_WRITE, env.GOOGLE_CALENDAR_ID_READ].filter(Boolean);

  for (const calendarId of calendarIds) {
    try {
      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?` +
        `timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=250`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (response.ok) {
        const data = await response.json();
        const source = calendarId === env.GOOGLE_CALENDAR_ID_WRITE ? 'new' : 'legacy';

        for (const event of (data.items || [])) {
          // Skip cancelled events
          if (event.status === 'cancelled') continue;

          // Skip non-booking events (Weekly Catch Up, meetings, etc.)
          if (!isBookingEvent(event)) continue;

          // Parse event to booking-like structure
          const startDate = event.start?.dateTime || event.start?.date;
          const endDate = event.end?.dateTime || event.end?.date;

          const desc = event.description || '';
          const nameFromDesc = parseName(desc);
          const studioUse = parseStudioUse(desc);

          allEvents.push({
            id: event.id,
            calendarEventId: event.id,
            calendarEmail: calendarId, // Store the calendar email for URL generation
            source,
            name: nameFromDesc || event.summary || 'Calendar Event',
            eventType: studioUse || parseEventType(event.summary || ''),
            date: startDate ? startDate.split('T')[0] : null,
            startTime: startDate,
            endTime: endDate,
            status: desc.includes('CONFIRMED') ? 'confirmed' :
                    desc.includes('PROVISIONAL') ? 'pending' : 'confirmed',
            guestCount: parseGuestCount(desc),
            email: parseEmail(desc),
            phone: parsePhone(desc),
            total: parseTotal(desc),
            deposit: parseDeposit(desc),
            fromCalendar: true,
            calendarSource: source === 'new' ? 'contacthibiscusstudio' : 'hibiscusstudiouk',
          });
        }
      }
    } catch (error) {
      console.error(`Failed to fetch events from ${calendarId}:`, error);
    }
  }

  return allEvents;
}

// Helper parsers for calendar event descriptions
function parseEventType(summary) {
  // Try to extract event type from summary like "Birthday Party - John" or just use summary
  const types = ['birthday', 'bridal', 'baby shower', 'photoshoot', 'content', 'party', 'event'];
  const lower = summary.toLowerCase();
  for (const type of types) {
    if (lower.includes(type)) {
      return type.charAt(0).toUpperCase() + type.slice(1);
    }
  }
  return summary.split(' - ')[0] || 'Event';
}

function parseGuestCount(description) {
  const match = description.match(/(\d+)\s*guests?/i);
  return match ? parseInt(match[1]) : null;
}

function parseName(description) {
  // Acuity format: "Name: Francesca Lepe"
  const match = description.match(/Name:\s*(.+?)(?:\n|$)/i);
  return match ? match[1].trim() : null;
}

function parseStudioUse(description) {
  // Acuity format: "What are you using the studio for?: Workshop : from passion to profit"
  const match = description.match(/What are you using the studio for\?:\s*(.+?)(?:\n|$)/i);
  return match ? match[1].trim() : null;
}

function parseEmail(description) {
  const match = description.match(/[\w.-]+@[\w.-]+\.\w+/);
  return match ? match[0] : null;
}

function parsePhone(description) {
  const match = description.match(/(?:\+44|0)\s*\d[\d\s-]{8,}/);
  return match ? match[0].trim() : null;
}

function parseTotal(description) {
  // Acuity format: "Price: £345.00"
  // Match price with optional decimals
  const patterns = [
    /price[:\s]*£(\d+(?:\.\d{2})?)/i,  // "Price: £345.00" or "Price: £300"
    /total[:\s]*£(\d+(?:\.\d{2})?)/i,  // "Total: £345.00"
    /£(\d+(?:\.\d{2})?)/i,              // Just "£345.00"
  ];

  for (const pattern of patterns) {
    const match = description.match(pattern);
    if (match) return Math.round(parseFloat(match[1])); // Round to nearest pound
  }
  return null;
}

function parseDeposit(description) {
  const patterns = [
    /deposit[:\s]*£(\d+(?:\.\d{2})?)/i,  // "Deposit: £150.00"
    /£(\d+(?:\.\d{2})?)\s*deposit/i,     // "£150 deposit"
  ];

  for (const pattern of patterns) {
    const match = description.match(pattern);
    if (match) return Math.round(parseFloat(match[1]));
  }
  return null;
}

// Check if a calendar event is a REAL booking (from Acuity or with proper markers)
function isBookingEvent(event) {
  const summary = (event.summary || '').toLowerCase();
  const description = event.description || '';
  const location = event.location || '';

  // STRONG POSITIVE: Acuity bookings are always real
  if (description.includes('AcuityID=') || description.includes('Acuity Scheduling')) {
    return true;
  }

  // STRONG POSITIVE: Has the studio location
  if (location.includes('Peto') || location.includes('E16 1DP') || location.includes('19 Peto')) {
    return true;
  }

  // STRONG POSITIVE: Has price in description (Acuity format)
  if (description.match(/Price:\s*£\d+/i)) {
    return true;
  }

  // Events to EXCLUDE (non-bookings)
  const excludePatterns = [
    'weekly catch up',
    'catch-up',
    'catchup',
    'meeting',
    'call',
    'sync',
    'standup',
    'stand-up',
    'reminder',
    'blocked',
    'unavailable',
    'holiday',
    'vacation',
    'out of office',
    'ooo',
    'workshop', // Generic workshop without Acuity data
  ];

  for (const pattern of excludePatterns) {
    if (summary.includes(pattern)) return false;
  }

  // If no strong positive markers and no description, probably not a booking
  if (!description || description.length < 50) {
    return false;
  }

  return true;
}

// Generate Google Calendar search URL - more reliable than direct event link
function getCalendarSearchUrl(name, date) {
  // Search for the person's name on their booking date
  const searchDate = new Date(date);
  const dateStr = searchDate.toISOString().split('T')[0]; // YYYY-MM-DD
  const searchQuery = `${name} ${dateStr}`;
  return `https://calendar.google.com/calendar/u/0/r/search?q=${encodeURIComponent(searchQuery)}`;
}

// Generate Google Calendar day view URL - opens calendar to specific date
function getDirectCalendarUrl(calendarEventId, calendarEmail, eventDate) {
  if (!calendarEmail || !eventDate) return null;
  // Open calendar to the day view for that date - user can see and click the event
  const date = new Date(eventDate);
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // 0-indexed
  const day = date.getDate();
  return `https://calendar.google.com/calendar/u/0/r/day/${year}/${month}/${day}?authuser=${encodeURIComponent(calendarEmail)}`;
}

// Simple calendar day view URL - just needs date (uses default account)
function getCalendarDayUrl(eventDate) {
  if (!eventDate) return null;
  const date = new Date(eventDate);
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `https://calendar.google.com/calendar/u/0/r/day/${year}/${month}/${day}`;
}

// ============================================
// Pricing
// ============================================

const DAMAGE_DEPOSIT = 200; // Fixed £200, separate from hire fee

// Event Hire pricing (bridal, birthday, baby shower, private, corporate)
const EVENT_HIRE_PRICES = {
  4: 345,   // 4 hours Flexi
  6: 465,   // Half-day (6 hours)
  8: 645,   // 8 hours Flexi
  12: 885   // Full-day (12 hours)
};

// Workshop pricing (education-focused, lower rates)
const WORKSHOP_PRICES = {
  2: 120,   // 2 hours
  6: 345,   // Half-day workshop
  12: 645   // Full-day workshop
};

// Content Creation pricing (fast turnaround, lowest rates)
const CONTENT_CREATION_PRICES = {
  2: 90,    // 2 hours quick shoot
  6: 250,   // Half-day shoot
  12: 500   // Full-day shoot
};

function calculatePrice(booking) {
  // Studio viewings have no cost
  if (isStudioViewing(booking)) {
    return {
      hireTotal: 0,
      hireDeposit: 0,
      damageDeposit: 0,
      surcharge: 0,
      addons: 0,
      duration: 0,
      // Legacy fields for backward compatibility
      total: 0,
      deposit: 0
    };
  }

  // Get duration from booking (default to 6 hours for legacy bookings)
  const duration = parseInt(booking.duration) || 6;

  // Determine pricing table based on event type
  const eventType = (booking.eventType || '').toLowerCase();
  let priceTable;

  if (eventType.includes('workshop')) {
    priceTable = WORKSHOP_PRICES;
  } else if (eventType.includes('content')) {
    priceTable = CONTENT_CREATION_PRICES;
  } else {
    priceTable = EVENT_HIRE_PRICES; // Default for bridal, birthday, baby, private, corporate
  }

  // Get base price from appropriate table (fallback to 6-hour event hire price)
  const basePrice = priceTable[duration] || EVENT_HIRE_PRICES[6];

  // Legacy surcharge support (for old time-slot based bookings)
  const slot = TIME_SLOTS.find(s => s.id === booking.timeSlot);
  const surcharge = slot?.surcharge || 0;

  let addons = 0;
  if (booking.extras?.catering) addons += 150;
  if (booking.extras?.dj) addons += 100;
  if (booking.extras?.photographer) addons += 200;

  const hireTotal = basePrice + surcharge + addons;
  const hireDeposit = Math.round(hireTotal * 0.5 * 100) / 100; // 50% of hire fee ONLY
  const damageDeposit = DAMAGE_DEPOSIT; // Fixed £200, separate

  return {
    hireTotal,
    hireDeposit,
    damageDeposit,
    surcharge,
    addons,
    duration,
    // Legacy fields for backward compatibility
    total: hireTotal,
    deposit: hireDeposit
  };
}

// Check if booking is a studio viewing (no payment required)
function isStudioViewing(booking) {
  const eventType = (booking.eventType || '').toLowerCase();
  return eventType.includes('viewing') || eventType.includes('studio view');
}

// ============================================
// Invoice Management
// ============================================

const INVOICE_PREFIX = 'HS';

// Generate next invoice number atomically
async function generateInvoiceNumber(env) {
  const year = new Date().getFullYear();
  const counterKey = `INVOICE_COUNTER_${year}`;

  // Get current counter
  let counter = parseInt(await env.BOOKINGS.get(counterKey) || '0', 10);
  counter += 1;

  // Store updated counter
  await env.BOOKINGS.put(counterKey, counter.toString());

  // Format: HS-2026-001
  return `${INVOICE_PREFIX}-${year}-${counter.toString().padStart(3, '0')}`;
}

// Create invoice record
function createInvoiceRecord(invoiceNumber, bookingId, type, amount, customerEmail, customerName) {
  return {
    id: invoiceNumber,
    bookingId,
    type, // 'hire' or 'damage_deposit'
    amount, // in pounds
    status: 'draft', // draft → sent → paid → voided
    voidedReason: null,
    supersededBy: null,
    customerEmail,
    customerName,
    createdAt: new Date().toISOString(),
    sentAt: null,
    paidAt: null
  };
}

// Store invoice in KV
async function storeInvoice(invoice, env) {
  const key = `invoice:${invoice.id}`;
  await env.BOOKINGS.put(key, JSON.stringify(invoice));
  return invoice;
}

// Get invoice from KV
async function getInvoice(invoiceId, env) {
  const key = `invoice:${invoiceId}`;
  const data = await env.BOOKINGS.get(key);
  return data ? safeJsonParse(data) : null;
}

// Update invoice status
async function updateInvoiceStatus(invoiceId, status, env, additionalFields = {}) {
  const invoice = await getInvoice(invoiceId, env);
  if (!invoice) return null;

  invoice.status = status;
  if (status === 'sent') invoice.sentAt = new Date().toISOString();
  if (status === 'paid') invoice.paidAt = new Date().toISOString();

  Object.assign(invoice, additionalFields);

  await storeInvoice(invoice, env);
  return invoice;
}

// Void an invoice (for reschedules/cancellations)
async function voidInvoice(invoiceId, reason, supersededBy, env) {
  return updateInvoiceStatus(invoiceId, 'voided', env, {
    voidedReason: reason,
    supersededBy
  });
}

// Get all invoices for a booking
async function getInvoicesForBooking(bookingId, env) {
  const list = await env.BOOKINGS.list({ prefix: 'invoice:' });
  const invoices = [];

  for (const key of list.keys) {
    const invoice = await getInvoice(key.name.replace('invoice:', ''), env);
    if (invoice && invoice.bookingId === bookingId) {
      invoices.push(invoice);
    }
  }

  return invoices;
}

// ============================================
// PDF Invoice Generation
// ============================================

const BUSINESS_DETAILS = {
  name: 'Hibiscus Studio Limited',
  address: '19A Peto Street North, London E16',
  email: 'contacthibiscusstudio@gmail.com',
  bank: {
    name: 'Hibiscus Studio Limited',
    sortCode: '04-06-05',
    accountNumber: '26606862'
  }
};

async function generateInvoicePDF(invoice, booking, type) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]); // A4 size
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const { width, height } = page.getSize();
  const margin = 50;
  let y = height - margin;

  // Colors - Elegant black/white theme
  const black = rgb(0, 0, 0);
  const gray = rgb(0.4, 0.4, 0.4);
  const charcoal = rgb(0.1, 0.1, 0.1); // Elegant dark

  // Helper to draw text
  const drawText = (text, x, yPos, options = {}) => {
    page.drawText(text, {
      x,
      y: yPos,
      size: options.size || 11,
      font: options.bold ? fontBold : font,
      color: options.color || black
    });
  };

  // Header - Business name
  drawText(BUSINESS_DETAILS.name, margin, y, { size: 20, bold: true, color: charcoal });
  y -= 20;
  drawText(BUSINESS_DETAILS.address, margin, y, { size: 10, color: gray });
  y -= 15;
  drawText(BUSINESS_DETAILS.email, margin, y, { size: 10, color: gray });

  // Invoice title (right aligned)
  const titleText = type === 'damage_deposit' ? 'DAMAGE DEPOSIT INVOICE' : 'EVENT HIRE INVOICE';
  drawText(titleText, width - margin - 200, height - margin, { size: 14, bold: true });

  // Invoice details
  y -= 40;
  drawText('Invoice Number:', margin, y, { bold: true });
  drawText(invoice.id, margin + 110, y);

  y -= 18;
  drawText('Date:', margin, y, { bold: true });
  drawText(new Date(invoice.createdAt).toLocaleDateString('en-GB'), margin + 110, y);

  y -= 18;
  drawText('Booking Reference:', margin, y, { bold: true });
  drawText(booking.id, margin + 110, y);

  // Customer details
  y -= 35;
  drawText('BILL TO:', margin, y, { size: 10, bold: true, color: gray });
  y -= 18;
  drawText(booking.name, margin, y, { bold: true });
  y -= 15;
  drawText(booking.email, margin, y);
  if (booking.phone) {
    y -= 15;
    drawText(booking.phone, margin, y);
  }

  // Event details
  y -= 35;
  drawText('EVENT DETAILS:', margin, y, { size: 10, bold: true, color: gray });
  y -= 18;
  drawText(`Date: ${new Date(booking.date).toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`, margin, y);
  y -= 15;
  if (booking.timeSlot) {
    drawText(`Time: ${getTimeSlotLabel(booking)}`, margin, y);
    y -= 15;
  }
  drawText(`Event Type: ${booking.eventType || 'Event Hire'}`, margin, y);

  // Line item table
  y -= 40;

  // Table header
  page.drawRectangle({
    x: margin,
    y: y - 5,
    width: width - (margin * 2),
    height: 25,
    color: rgb(0.95, 0.95, 0.95)
  });

  drawText('Description', margin + 10, y, { bold: true });
  drawText('Amount', width - margin - 80, y, { bold: true });

  y -= 30;

  // Line items
  if (type === 'damage_deposit') {
    drawText('Refundable Damage Deposit', margin + 10, y);
    drawText(`£${invoice.amount.toFixed(2)}`, width - margin - 80, y);
    y -= 20;
    drawText('(Refunded within 7 days after event, subject to inspection)', margin + 10, y, { size: 9, color: gray });
  } else {
    // Hire invoice - show deposit breakdown
    const hireTotal = booking.hireTotal || booking.total || invoice.amount * 2;
    drawText(`Event Hire (${booking.eventType || 'Event'})`, margin + 10, y);
    drawText(`£${hireTotal.toFixed(2)}`, width - margin - 80, y);
    y -= 25;

    // Deposit line
    drawText('50% Deposit Due Now', margin + 10, y, { bold: true });
    drawText(`£${invoice.amount.toFixed(2)}`, width - margin - 80, y, { bold: true });
    y -= 20;

    // Balance line
    const balance = hireTotal - invoice.amount;
    drawText('Balance Due (10 working days before event)', margin + 10, y, { color: gray });
    drawText(`£${balance.toFixed(2)}`, width - margin - 80, y, { color: gray });
  }

  // Total box
  y -= 40;
  page.drawRectangle({
    x: width - margin - 180,
    y: y - 10,
    width: 180,
    height: 35,
    color: rgb(0.1, 0.1, 0.1),
    opacity: 0.08
  });
  page.drawRectangle({
    x: width - margin - 180,
    y: y - 10,
    width: 180,
    height: 35,
    borderColor: charcoal,
    borderWidth: 1
  });

  drawText('AMOUNT DUE:', width - margin - 170, y + 5, { bold: true });
  drawText(`£${invoice.amount.toFixed(2)}`, width - margin - 60, y + 5, { size: 14, bold: true, color: charcoal });

  // Payment details
  y -= 60;
  drawText('PAYMENT DETAILS:', margin, y, { size: 10, bold: true, color: gray });
  y -= 20;
  drawText('Bank Transfer:', margin, y, { bold: true });
  y -= 18;
  drawText(`Account Name: ${BUSINESS_DETAILS.bank.name}`, margin + 20, y);
  y -= 15;
  drawText(`Sort Code: ${BUSINESS_DETAILS.bank.sortCode}`, margin + 20, y);
  y -= 15;
  drawText(`Account Number: ${BUSINESS_DETAILS.bank.accountNumber}`, margin + 20, y);
  y -= 15;
  drawText(`Reference: ${invoice.id}`, margin + 20, y, { bold: true, color: charcoal });

  // Footer
  y = margin + 40;
  page.drawLine({
    start: { x: margin, y: y + 20 },
    end: { x: width - margin, y: y + 20 },
    thickness: 0.5,
    color: gray
  });

  drawText('Thank you for booking with Hibiscus Studio!', margin, y, { size: 10, color: gray });
  y -= 15;
  drawText('Questions? Contact us at contacthibiscusstudio@gmail.com', margin, y, { size: 9, color: gray });

  // Generate PDF bytes
  const pdfBytes = await pdfDoc.save();
  return pdfBytes;
}

// ============================================
// Resend Email Integration
// ============================================

async function sendInvoiceEmail(booking, invoices, pdfAttachments, env, options = {}) {
  // Skip in test mode
  if (options.testMode) {
    console.log('[TEST MODE] Skipping Resend email');
    return { skipped: true, reason: 'test_mode' };
  }

  if (!env.RESEND_API_KEY) {
    console.log('Resend API key not configured, falling back to Apps Script');
    return { skipped: true, reason: 'no_api_key' };
  }

  const hireInvoice = invoices.find(i => i.type === 'hire');
  const damageInvoice = invoices.find(i => i.type === 'damage_deposit');

  // Build email body
  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #1a1a1a; padding: 30px; border-radius: 12px 12px 0 0; text-align: center; }
        .header h1 { color: white; margin: 0; font-size: 24px; }
        .content { background: #f9fafb; padding: 30px; border-radius: 0 0 12px 12px; }
        .booking-ref { background: #141414; color: white; padding: 15px; border-radius: 8px; text-align: center; margin: 20px 0; }
        .booking-ref code { font-size: 18px; color: #fafafa; }
        .details { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
        .details h3 { margin-top: 0; color: #1a1a1a; }
        .bank-details { background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0; }
        .amount { font-size: 24px; font-weight: bold; color: #1a1a1a; }
        .footer { text-align: center; padding: 20px; color: #666; font-size: 14px; }
        table { width: 100%; border-collapse: collapse; }
        td { padding: 8px 0; }
        .label { color: #666; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Booking Confirmed!</h1>
        </div>
        <div class="content">
          <p>Hi ${booking.name},</p>
          <p>Thank you for booking with Hibiscus Studio. Your invoices are attached to this email.</p>

          <div class="booking-ref">
            <div style="color: #888; font-size: 12px;">BOOKING REFERENCE</div>
            <code>${booking.id}</code>
          </div>

          <div class="details">
            <h3>Event Details</h3>
            <table>
              <tr><td class="label">Date:</td><td><strong>${new Date(booking.date).toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</strong></td></tr>
              <tr><td class="label">Time:</td><td>${getTimeSlotLabel(booking)}</td></tr>
              <tr><td class="label">Event Type:</td><td>${booking.eventType || 'Event Hire'}</td></tr>
            </table>
          </div>

          <div class="details">
            <h3>Payment Summary</h3>
            <table>
              ${hireInvoice ? `<tr><td>Event Hire Deposit (50%)</td><td style="text-align:right"><strong>£${hireInvoice.amount.toFixed(2)}</strong></td></tr>` : ''}
              ${damageInvoice ? `<tr><td>Damage Deposit (Refundable)</td><td style="text-align:right"><strong>£${damageInvoice.amount.toFixed(2)}</strong></td></tr>` : ''}
              <tr style="border-top: 2px solid #1a1a1a;"><td><strong>Total Due Now</strong></td><td style="text-align:right" class="amount">£${invoices.reduce((sum, i) => sum + i.amount, 0).toFixed(2)}</td></tr>
            </table>
          </div>

          <div class="bank-details">
            <h3 style="margin-top: 0;">Bank Transfer Details</h3>
            <table>
              <tr><td class="label">Account Name:</td><td><strong>${BUSINESS_DETAILS.bank.name}</strong></td></tr>
              <tr><td class="label">Sort Code:</td><td><strong>${BUSINESS_DETAILS.bank.sortCode}</strong></td></tr>
              <tr><td class="label">Account Number:</td><td><strong>${BUSINESS_DETAILS.bank.accountNumber}</strong></td></tr>
              <tr><td class="label">Reference:</td><td><strong style="color: #10b981;">${hireInvoice?.id || booking.id}</strong></td></tr>
            </table>
          </div>

          <p><strong>What's next?</strong></p>
          <ol>
            <li>Transfer the total amount using the bank details above</li>
            <li>Use your invoice number as the payment reference</li>
            <li>We'll confirm receipt within 4 hours (or Monday 10am for weekend transfers)</li>
          </ol>

          ${damageInvoice ? '<p><em>Note: Your £200 damage deposit will be refunded within 7 days after your event, subject to inspection.</em></p>' : ''}
        </div>
        <div class="footer">
          <p>Questions? Reply to this email or contact us at ${BUSINESS_DETAILS.email}</p>
          <p>Hibiscus Studio | ${BUSINESS_DETAILS.address}</p>
        </div>
      </div>
    </body>
    </html>
  `;

  // Prepare attachments
  const attachments = pdfAttachments.map((pdf, index) => ({
    filename: `${invoices[index].id}.pdf`,
    content: arrayBufferToBase64(pdf)
  }));

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        // Note: Change to 'Hibiscus Studio <bookings@hibiscusstudio.co.uk>' after domain verification in Resend
        from: env.RESEND_FROM_EMAIL || 'Hibiscus Studio <onboarding@resend.dev>',
        to: booking.email,
        subject: `Booking Confirmed - Invoice ${hireInvoice?.id || booking.id}`,
        html: emailHtml,
        attachments
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Resend API error:', error);
      return { success: false, error };
    }

    const result = await response.json();
    return { success: true, messageId: result.id };
  } catch (error) {
    console.error('Resend email failed:', error);
    return { success: false, error: error.message };
  }
}

// Helper to convert ArrayBuffer to Base64
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ============================================
// Open House Viewing Confirmation Email
// ============================================

async function sendViewingConfirmationEmail(booking, env) {
  if (!env.RESEND_API_KEY) {
    console.log('No RESEND_API_KEY — skipping viewing confirmation email');
    return { skipped: true };
  }

  const timeLabel = booking.startTime
    ? `${booking.startTime}${booking.endTime ? ' – ' + booking.endTime : ''}`
    : 'your booked slot';

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, sans-serif; background: #f9f9f9; margin: 0; padding: 0; }
    .wrap { max-width: 500px; margin: 40px auto; background: #fff; border-radius: 12px; overflow: hidden; }
    .header { background: #1a1a1a; padding: 32px; text-align: center; }
    .header img { height: 36px; }
    .header h1 { color: #fff; font-size: 20px; margin: 16px 0 4px; }
    .header p { color: #aaa; font-size: 14px; margin: 0; }
    .body { padding: 32px; }
    .detail { background: #f5f5f5; border-radius: 8px; padding: 20px; margin: 24px 0; }
    .detail p { margin: 6px 0; font-size: 15px; color: #333; }
    .detail strong { color: #111; }
    .cta { display: block; background: #111; color: #fff; text-decoration: none; text-align: center; padding: 14px; border-radius: 8px; font-weight: 600; margin-top: 24px; }
    .footer { padding: 24px 32px; border-top: 1px solid #eee; font-size: 12px; color: #999; text-align: center; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <h1>You're booked.</h1>
      <p>Open House — Saturday 7th March</p>
    </div>
    <div class="body">
      <p>Hi ${booking.name},</p>
      <p>We've reserved your viewing slot. Here's everything you need:</p>
      <div class="detail">
        <p><strong>Date:</strong> Saturday 7th March 2026</p>
        <p><strong>Time:</strong> ${timeLabel}</p>
        <p><strong>Location:</strong> 19A Peto Street North, London E16 1DP</p>
        <p><strong>Duration:</strong> 20 minutes</p>
      </div>
      <p>Rochelle will meet you at the studio. No pressure, no obligation — just come and see the space.</p>
      <a class="cta" href="https://maps.google.com/?q=19A+Peto+Street+North+London+E16+1DP">Get directions</a>
    </div>
    <div class="footer">
      <p>Questions? Reply to this email or find us on Instagram <a href="https://www.instagram.com/hibiscusstudiosuk">@hibiscusstudiosuk</a></p>
      <p>Hibiscus Studio | 19A Peto Street North, London E16 1DP</p>
    </div>
  </div>
</body>
</html>`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL || 'Hibiscus Studio <onboarding@resend.dev>',
        to: booking.email,
        subject: `Your viewing is confirmed — Saturday 7th March`,
        html,
      }),
    });
    if (!response.ok) {
      const err = await response.text();
      console.error('Resend viewing email error:', err);
      return { success: false, error: err };
    }
    const result = await response.json();
    console.log('Viewing confirmation email sent:', result.id);
    return { success: true, messageId: result.id };
  } catch (err) {
    console.error('Viewing confirmation email failed:', err);
    return { success: false, error: err.message };
  }
}

// ============================================
// Invoice Generation Orchestrator
// ============================================

async function generateAndSendInvoices(booking, env, options = {}) {
  // Skip for studio viewings
  if (isStudioViewing(booking)) {
    console.log('Studio viewing - skipping invoice generation');
    return { skipped: true, reason: 'studio_viewing' };
  }

  const invoices = [];
  const pdfAttachments = [];
  const errors = [];

  try {
    // Generate hire invoice
    const hireInvoiceNumber = await generateInvoiceNumber(env);
    const hireInvoice = createInvoiceRecord(
      hireInvoiceNumber,
      booking.id,
      'hire',
      booking.hireDeposit || booking.deposit,
      booking.email,
      booking.name
    );
    await storeInvoice(hireInvoice, env);
    invoices.push(hireInvoice);

    // Generate hire PDF
    const hirePdf = await generateInvoicePDF(hireInvoice, booking, 'hire');
    pdfAttachments.push(hirePdf);

    // Generate damage deposit invoice
    const damageInvoiceNumber = await generateInvoiceNumber(env);
    const damageInvoice = createInvoiceRecord(
      damageInvoiceNumber,
      booking.id,
      'damage_deposit',
      booking.damageDeposit || DAMAGE_DEPOSIT,
      booking.email,
      booking.name
    );
    await storeInvoice(damageInvoice, env);
    invoices.push(damageInvoice);

    // Generate damage deposit PDF
    const damagePdf = await generateInvoicePDF(damageInvoice, booking, 'damage_deposit');
    pdfAttachments.push(damagePdf);

    // Send email with both invoices
    const emailResult = await sendInvoiceEmail(booking, invoices, pdfAttachments, env, options);

    if (emailResult.success) {
      // Update invoice statuses to 'sent'
      for (const invoice of invoices) {
        await updateInvoiceStatus(invoice.id, 'sent', env);
      }
    } else if (!emailResult.skipped) {
      errors.push({ type: 'email', error: emailResult.error });
    }

    // Store invoice IDs on the booking
    booking.invoiceIds = invoices.map(i => i.id);

    return {
      success: true,
      invoices: invoices.map(i => i.id),
      emailSent: emailResult.success || emailResult.skipped,
      errors: errors.length > 0 ? errors : undefined
    };

  } catch (error) {
    console.error('Invoice generation failed:', error);

    // Flag the booking for manual follow-up
    booking.invoiceGenerationFailed = true;
    booking.invoiceError = error.message;

    return {
      success: false,
      error: error.message,
      invoices: invoices.map(i => i.id) // Return any invoices that were created
    };
  }
}

// ============================================
// Apps Script Webhook (Legacy - kept for backward compatibility)
// ============================================

async function triggerAppsScript(action, data, env, options = {}) {
  // Skip email in test mode
  if (options.testMode) {
    console.log(`[TEST MODE] Skipping email: ${action}`);
    return { skipped: true, action };
  }

  if (!env.APPS_SCRIPT_WEBHOOK) {
    console.log('Apps Script webhook not configured, skipping email');
    return;
  }

  try {
    const response = await fetch(env.APPS_SCRIPT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...data }),
    });
    // B3: Check response — fire-and-forget was silently swallowing failures
    if (!response.ok) {
      const body = await response.text().catch(() => '(unreadable)');
      console.error(`Apps Script trigger failed: action=${action} status=${response.status} body=${body}`);
      return { failed: true, action, status: response.status };
    }
    return { ok: true, action };
  } catch (error) {
    console.error(`Apps Script trigger threw: action=${action} error=${error.message}`);
    return { failed: true, action, error: error.message };
  }
}

// Helper to detect test mode from request
function isTestMode(request) {
  const url = new URL(request.url);
  return url.searchParams.get('test') === '1' || url.searchParams.get('test') === 'true';
}

// ============================================
// Integration Script (served to frontend)
// ============================================

function getIntegrationScript() {
  return `
/**
 * Hibiscus Booking Frontend Integration
 * Auto-loaded from API server
 */

(function() {
  const API_BASE = 'https://hb-booking.nicholasfcoker.workers.dev';
  const TEST_MODE = new URLSearchParams(window.location.search).get('test') === '1';

  // Show test mode banner
  if (TEST_MODE) {
    document.addEventListener('DOMContentLoaded', () => {
      const banner = document.createElement('div');
      banner.innerHTML = '<div style="background: #f59e0b; color: #000; padding: 8px 16px; text-align: center; font-weight: 600; font-size: 14px;">🧪 TEST MODE - Emails will NOT be sent</div>';
      document.body.insertBefore(banner.firstChild, document.body.firstChild);
    });
  }

  // Override functions that set button text and change button text on load
  document.addEventListener('DOMContentLoaded', () => {
    // Initial button text change
    const payBtn = document.querySelector('.btn-primary[onclick="showConfirmation()"]');
    if (payBtn) {
      payBtn.textContent = 'Submit Booking Request';
    }

    // Store original functions
    const originalUpdateDeposit = window.updateDepositAmount;
    const originalResetDemo = window.resetDemo;

    // Override updateDepositAmount to keep "Submit Booking Request"
    if (originalUpdateDeposit) {
      window.updateDepositAmount = function() {
        originalUpdateDeposit();
        const btn = document.querySelector('.btn-primary[onclick="showConfirmation()"]');
        if (btn) btn.textContent = 'Submit Booking Request';
      };
    }

    // Override resetDemo to keep "Submit Booking Request"
    if (originalResetDemo) {
      window.resetDemo = function() {
        originalResetDemo();
        const btn = document.querySelector('.btn-primary[onclick="showConfirmation()"]');
        if (btn) btn.textContent = 'Submit Booking Request';
      };
    }
  });

  // Helper: get time slot ID from start time (legacy support)
  function getTimeSlotId(startTime) {
    const slotMap = { '12:00': 'morning', '14:00': 'afternoon', '16:00': 'evening', '18:00': 'latenight' };
    return slotMap[startTime] || 'afternoon';
  }

  // Helper: get selected extras
  function getSelectedExtras() {
    const extras = {};
    const cateringCb = document.getElementById('extraCatering');
    const djCb = document.getElementById('extraDJ');
    const photographerCb = document.getElementById('extraPhotographer');
    if (cateringCb?.checked) extras.catering = true;
    if (djCb?.checked) extras.dj = true;
    if (photographerCb?.checked) extras.photographer = true;
    return extras;
  }

  // Override showConfirmation to submit to API
  window.showConfirmation = async function() {
    const submitBtn = document.querySelector('.btn-primary[onclick="showConfirmation()"]');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    try {
      // Build booking data - support both new (duration) and legacy (timeSlot) formats
      const bookingData = {
        eventType: window.eventTypeLabels?.[window.selectedEventType] || window.selectedEventType,
        date: window.selectedDate,
        guestCount: window.selectedGuests,
        name: document.getElementById('inputName').value.trim(),
        email: document.getElementById('inputEmail').value.trim(),
        phone: document.getElementById('inputPhone').value.trim(),
        extras: getSelectedExtras(),
      };

      // If duration is set, use new format; otherwise use legacy timeSlot
      if (window.selectedDuration) {
        bookingData.duration = window.selectedDuration;
        bookingData.startTime = window.selectedTimeStart;
        bookingData.endTime = window.selectedTimeEnd;
      } else {
        bookingData.timeSlot = getTimeSlotId(window.selectedTimeStart);
      }

      const apiUrl = TEST_MODE ? API_BASE + '/api/bookings?test=1' : API_BASE + '/api/bookings';
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bookingData),
      });

      const result = await response.json();

      if (!response.ok) {
        if (result.error === 'slot_taken') {
          showSlotTakenModal(result.alternatives || []);
          submitBtn.disabled = false;
          submitBtn.textContent = originalText;
          return;
        }
        throw new Error(result.error || 'Booking failed');
      }

      showBookingSuccess(result);

    } catch (error) {
      console.error('Booking submission failed:', error);
      alert('Sorry, something went wrong. Please try again or contact us directly.');
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  };

  // Success screen
  function showBookingSuccess(result) {
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    document.getElementById('progressBar').style.display = 'none';

    const step9 = document.getElementById('step9');
    step9.innerHTML = \`
      <div class="success-screen">
        <div class="success-icon">
          <svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" stroke="#10b981"/>
            <path d="M8 12l3 3 5-5" stroke="#10b981" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>

        <h2 style="color: #10b981; margin: 16px 0 8px;">Booking Request Received!</h2>
        <p style="color: #888; margin-bottom: 24px;">Complete your payment to confirm</p>

        <div class="booking-reference" style="background: #141414; padding: 16px; border-radius: 12px; margin-bottom: 24px;">
          <div style="color: #666; font-size: 12px; margin-bottom: 4px;">Booking Reference</div>
          <div style="font-family: monospace; font-size: 20px; color: #fff;">\${result.bookingId}</div>
          \${result.testMode ? '<div style="color: #f59e0b; font-size: 11px; margin-top: 8px;">🧪 Test booking - no email sent</div>' : ''}
        </div>

        <div class="payment-box" style="background: linear-gradient(135deg, #1f1f1f, #2a2a2a); border: 1px solid #404040; padding: 20px; border-radius: 12px; margin-bottom: 24px;">
          <div style="font-size: 14px; color: #a3a3a3; margin-bottom: 12px;">Transfer to confirm your booking</div>

          <div style="display: grid; gap: 12px; text-align: left;">
            <div>
              <div style="color: #666; font-size: 11px;">Account Name</div>
              <div style="color: #fff; font-family: monospace;">\${result.bankDetails.accountName}</div>
            </div>
            <div>
              <div style="color: #666; font-size: 11px;">Sort Code</div>
              <div style="color: #fff; font-family: monospace;">\${result.bankDetails.sortCode}</div>
            </div>
            <div>
              <div style="color: #666; font-size: 11px;">Account Number</div>
              <div style="color: #fff; font-family: monospace;">\${result.bankDetails.accountNumber}</div>
            </div>
            <div>
              <div style="color: #666; font-size: 11px;">Reference (important!)</div>
              <div style="color: #10b981; font-family: monospace; font-weight: 600;">\${result.bookingId}</div>
            </div>
          </div>

          <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid #404040;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
              <span style="color: #888;">Deposit due now</span>
              <span style="color: #10b981; font-weight: 600; font-size: 18px;">£\${result.deposit}</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: #666; font-size: 12px;">Total</span>
              <span style="color: #666; font-size: 12px;">£\${result.total}</span>
            </div>
          </div>
        </div>

        <div class="next-steps" style="background: #1f1f1f; padding: 16px; border-radius: 12px; text-align: left;">
          <div style="color: #fff; font-weight: 500; margin-bottom: 12px;">What happens next?</div>
          <ul style="color: #888; padding-left: 20px; line-height: 1.8; margin: 0;">
            <li>Check your email for the invoice</li>
            <li>Transfer the deposit using the reference above</li>
            <li>We'll confirm within 4 hours of payment clearing</li>
            <li>Weekend transfers confirmed by Monday 10am</li>
          </ul>
        </div>

        <button class="btn btn-secondary" style="margin-top: 24px;" onclick="location.reload()">
          Book Another Event
        </button>
      </div>
    \`;

    step9.classList.add('active');
  }

  // Slot taken modal — handles both legacy (id-based) and duration (start/end) alternatives
  function showSlotTakenModal(alternatives) {
    const existing = document.getElementById('slotTakenModal');
    if (existing) existing.remove();

    const alternativesHtml = alternatives.length > 0
      ? alternatives.map(slot => {
          // Duration format has start/end directly; legacy has id
          const start = slot.start || '';
          const end = slot.end || '';
          const label = slot.label || (start + ' - ' + end);
          return \`
          <button class="alt-slot-btn" onclick="window._selectAlternativeSlot('\${start}', '\${end}', '\${label}')">
            <span class="slot-time">\${label}</span>
            \${slot.surcharge > 0 ? '<span class="slot-surcharge">+£' + slot.surcharge + '</span>' : ''}
          </button>
        \`;
        }).join('')
      : '<p style="color: #888;">No other slots available for this date. Please try another date.</p>';

    const modal = document.createElement('div');
    modal.id = 'slotTakenModal';
    modal.innerHTML = \`
      <div class="modal-backdrop" onclick="window._closeSlotTakenModal()"></div>
      <div class="modal-content">
        <div class="modal-icon">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#f59e0b" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
        </div>
        <h3 style="color: #fff; margin: 16px 0 8px;">This slot was just booked</h3>
        <p style="color: #888; margin-bottom: 20px;">Someone else completed their booking while you were filling out the form.</p>
        <div class="alternatives-section">
          <div style="color: #a3a3a3; font-size: 14px; margin-bottom: 12px;">Available times for this date:</div>
          <div class="alternatives-list">\${alternativesHtml}</div>
        </div>
        <div style="display: flex; gap: 12px; margin-top: 20px;">
          <button class="btn btn-secondary" style="flex: 1;" onclick="window._closeSlotTakenModal(); goToStep(4);">
            Choose Different Date
          </button>
        </div>
      </div>
    \`;

    if (!document.getElementById('modalStyles')) {
      const styles = document.createElement('style');
      styles.id = 'modalStyles';
      styles.textContent = \`
        #slotTakenModal { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 20px; }
        .modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.8); }
        .modal-content { position: relative; background: #141414; border-radius: 16px; padding: 24px; max-width: 400px; width: 100%; text-align: center; border: 1px solid #333; }
        .alternatives-list { display: flex; flex-direction: column; gap: 8px; }
        .alt-slot-btn { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; background: #1f1f1f; border: 1px solid #333; border-radius: 8px; color: #fff; cursor: pointer; transition: all 0.2s; }
        .alt-slot-btn:hover { background: #333; border-color: #404040; }
        .slot-surcharge { color: #f59e0b; font-size: 12px; }
      \`;
      document.head.appendChild(styles);
    }

    document.body.appendChild(modal);
  }

  window._closeSlotTakenModal = function() {
    const modal = document.getElementById('slotTakenModal');
    if (modal) modal.remove();
  };

  window._selectAlternativeSlot = function(start, end, label) {
    if (start && end) {
      window.selectedTimeStart = start;
      window.selectedTimeEnd = end;
      window.selectedTimeLabel = label;
      const summaryTime = document.getElementById('summaryTime');
      if (summaryTime) summaryTime.textContent = label;
    }
    window._closeSlotTakenModal();
    window.showConfirmation();
  };

  // ============================================
  // Live Availability Checking
  // ============================================

  async function fetchAvailability(date) {
    try {
      const response = await fetch(API_BASE + '/api/availability?date=' + date);
      if (!response.ok) throw new Error('Failed to fetch availability');
      return await response.json();
    } catch (error) {
      console.error('Availability check failed:', error);
      return null;
    }
  }

  function updateTimeSlotAvailability(slots) {
    // Find time slot elements and update availability
    document.querySelectorAll('.time-option, .time-slot').forEach(card => {
      const startTime = card.dataset?.start || card.getAttribute('data-start');
      if (!startTime) return;

      const slot = slots.find(s => s.start === startTime);

      if (slot && !slot.available) {
        card.classList.add('unavailable');
        card.style.opacity = '0.4';
        card.style.pointerEvents = 'none';

        // Add "Booked" label if not already present
        if (!card.querySelector('.booked-label')) {
          const label = document.createElement('span');
          label.className = 'booked-label';
          label.textContent = 'Booked';
          label.style.cssText = 'position: absolute; top: 8px; right: 8px; background: #ef4444; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 11px;';
          card.style.position = 'relative';
          card.appendChild(label);
        }
      } else {
        card.classList.remove('unavailable');
        card.style.opacity = '1';
        card.style.pointerEvents = 'auto';
        const label = card.querySelector('.booked-label');
        if (label) label.remove();
      }
    });
  }

  // Override selectDate to fetch live availability
  document.addEventListener('DOMContentLoaded', () => {
    const originalSelectDate = window.selectDate;
    if (typeof originalSelectDate === 'function') {
      window.selectDate = async function(el, dateStr, day, num, month) {
        // Call original selection logic with all arguments
        originalSelectDate(el, dateStr, day, num, month);

        // Show loading state on time slots
        document.querySelectorAll('.time-option, .time-slot').forEach(card => {
          card.style.opacity = '0.6';
        });

        // Fetch live availability
        const availability = await fetchAvailability(dateStr);
        if (availability && availability.slots) {
          updateTimeSlotAvailability(availability.slots);
        } else {
          // Reset all slots to available if fetch fails
          document.querySelectorAll('.time-option, .time-slot').forEach(card => {
            card.style.opacity = '1';
          });
        }
      };
    }
  });

  console.log('Hibiscus Booking Integration loaded. API:', API_BASE, TEST_MODE ? '(TEST MODE)' : '');
})();
`;
}

// ============================================
// API Routes
// ============================================

// Health check
router.get('/api/health', () => json({ status: 'ok', service: 'hb-booking' }));

// Get booked viewing slots for the open house page
router.get('/api/open-house/booked', async (request, env) => {
  const url = new URL(request.url);
  const date = url.searchParams.get('date');
  if (!date) return json({ bookedTimes: [] });

  try {
    const list = await env.BOOKINGS.list();
    const bookedTimes = [];
    for (const key of list.keys) {
      const raw = await env.BOOKINGS.get(key.name);
      if (!raw) continue;
      try {
        const b = JSON.parse(raw);
        if (b.date === date && isStudioViewing(b) && b.startTime) {
          bookedTimes.push(b.startTime);
        }
      } catch (_) {}
    }
    return json({ bookedTimes });
  } catch (err) {
    console.error('open-house/booked failed:', err);
    return json({ bookedTimes: [] });
  }
});

// Serve integration script
router.get('/integration.js', () => {
  const script = getIntegrationScript();
  return new Response(script, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/javascript',
      'Cache-Control': 'public, max-age=300', // 5 min cache
    },
  });
});

// Get availability for a date
router.get('/api/availability', async (request, env) => {
  const url = new URL(request.url);
  const date = url.searchParams.get('date');
  const debug = url.searchParams.get('debug') === '1';

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ error: 'Invalid date format. Use YYYY-MM-DD' }, 400);
  }

  const duration = url.searchParams.get('duration');

  try {
    const result = await checkAvailability(date, env, debug, duration ? parseInt(duration) : null);
    if (debug) {
      return json({ date, slots: result.slots, debug: result.debug });
    }
    return json({ date, slots: result });
  } catch (error) {
    console.error('Availability check failed:', error);
    return json({ error: 'Failed to check availability' }, 500);
  }
});

// Create a booking
router.post('/api/bookings', async (request, env) => {
  try {
    const body = await request.json();
    const testMode = isTestMode(request) || body.test === true;

    // Validate required fields - support both legacy (timeSlot) and new (duration + startTime/endTime) formats
    const baseRequired = ['name', 'email', 'phone', 'date', 'eventType', 'guestCount'];
    for (const field of baseRequired) {
      if (!body[field]) {
        return json({ error: `Missing required field: ${field}` }, 400);
      }
    }

    // Check for either timeSlot (legacy) or duration+startTime+endTime (new)
    const hasLegacyFormat = !!body.timeSlot;
    const hasNewFormat = body.duration && body.startTime && body.endTime;

    // B2: Tuesday constraint — hard gate at API level regardless of UI
    const bookingDayOfWeek = new Date(body.date + 'T12:00:00').getDay();
    if (bookingDayOfWeek === 2) { // Tuesday
      const startOk = hasNewFormat && body.startTime >= '14:00';
      const endOk = hasNewFormat && body.endTime <= '16:00';
      if (!startOk || !endOk) {
        return json({
          error: 'tuesday_constraint',
          message: 'Tuesday bookings are 2pm–4pm only.',
        }, 400);
      }
    }

    if (!hasLegacyFormat && !hasNewFormat) {
      return json({
        error: 'Missing time selection. Provide either timeSlot or (duration + startTime + endTime)',
      }, 400);
    }

    // For legacy format, check availability using TIME_SLOTS
    if (hasLegacyFormat) {
      const slots = await checkAvailability(body.date, env);
      const selectedSlot = slots.find(s => s.id === body.timeSlot);

      if (!selectedSlot?.available) {
        const alternatives = slots.filter(s => s.available).slice(0, 3);
        return json({
          error: 'slot_taken',
          message: 'This slot was just booked by another customer.',
          alternatives,
        }, 409);
      }
    }

    // For new format, check availability by querying busy periods for the requested time range
    if (!hasLegacyFormat) {
      const accessToken = await getAccessToken(env);
      const startDateTime = new Date(`${body.date}T${body.startTime}:00`).toISOString();
      const endDateTime = new Date(`${body.date}T${body.endTime}:00`).toISOString();

      // Query freeBusy for both calendars
      const freeBusyResponse = await fetch(
        'https://www.googleapis.com/calendar/v3/freeBusy',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            timeMin: startDateTime,
            timeMax: endDateTime,
            items: [
              { id: env.GOOGLE_CALENDAR_ID_WRITE },
              { id: env.GOOGLE_CALENDAR_ID_READ },
            ],
          }),
        }
      );

      const freeBusyData = await freeBusyResponse.json();
      const writeCalBusy = freeBusyData.calendars?.[env.GOOGLE_CALENDAR_ID_WRITE]?.busy || [];
      const readCalBusy = freeBusyData.calendars?.[env.GOOGLE_CALENDAR_ID_READ]?.busy || [];
      const busyPeriods = [...writeCalBusy, ...readCalBusy];

      // Check if requested time overlaps with any busy period
      if (busyPeriods.length > 0) {
        const requestedStart = new Date(startDateTime);
        const requestedEnd = new Date(endDateTime);

        const hasConflict = busyPeriods.some(period => {
          const busyStart = new Date(period.start);
          const busyEnd = new Date(period.end);
          // Check for overlap: requested starts before busy ends AND requested ends after busy starts
          return requestedStart < busyEnd && requestedEnd > busyStart;
        });

        if (hasConflict) {
          // Find available alternatives for this duration on this date
          const duration = body.duration || 6;
          const allSlots = await checkAvailability(body.date, env, false, duration);
          const alternatives = allSlots.filter(s => s.available).slice(0, 4);

          return json({
            error: 'slot_taken',
            message: 'This time slot was just booked by another customer. Please select a different time.',
            alternatives,
            busyPeriods, // Show what's blocking (for debugging)
          }, 409);
        }
      }
    }

    // Calculate pricing (or use override for special bookings)
    let pricing;
    if (body.overridePrice && typeof body.overridePrice === 'number') {
      // Special booking with custom pricing
      pricing = {
        hireTotal: body.overridePrice,
        hireDeposit: Math.round(body.overridePrice * 0.5 * 100) / 100,
        damageDeposit: 0, // No damage deposit for special bookings
        surcharge: 0,
        addons: 0,
        total: body.overridePrice,
        deposit: Math.round(body.overridePrice * 0.5 * 100) / 100,
      };
    } else {
      pricing = calculatePrice(body);
    }

    // Generate booking ID
    const bookingId = `HB-${Date.now().toString(36).toUpperCase()}`;

    const booking = {
      id: bookingId,
      ...body,
      ...pricing,
      status: 'pending',
      depositPaid: false,
      balancePaid: false,
      createdAt: new Date().toISOString(),
    };

    // Create calendar event
    const calendarEvent = await createProvisionalEvent(booking, env);
    booking.calendarEventId = calendarEvent.id;

    // Store in KV (initial save before invoice generation)
    await env.BOOKINGS.put(bookingId, JSON.stringify(booking), {
      expirationTtl: 60 * 60 * 24 * 90, // 90 days
    });

    // B4: Telegram notification — immediate alert to Rochelle, independent of email health
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      const timeLabel = getTimeSlotLabel(booking);
      const msg = `📅 New HBS booking\n\n👤 ${booking.name}\n📧 ${booking.email}\n📞 ${booking.phone}\n\n🗓 ${booking.date} · ${timeLabel}\n🎉 ${booking.eventType} · ${booking.guestCount} guests\n\n💷 Deposit: £${booking.hireDeposit || booking.deposit} / Total: £${booking.hireTotal || booking.total}\n🔖 Ref: ${bookingId}`;
      const tgUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
      const tgBase = { chat_id: env.TELEGRAM_CHAT_ID, text: msg };
      if (env.TELEGRAM_THREAD_ID) tgBase.message_thread_id = Number(env.TELEGRAM_THREAD_ID);
      fetch(tgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tgBase),
      }).catch(err => console.error('Telegram booking notification failed:', err.message));
    }

    // Generate and send invoices (non-blocking - booking succeeds even if invoices fail)
    let invoiceResult = { skipped: true };
    try {
      invoiceResult = await generateAndSendInvoices(booking, env, { testMode });

      // Update booking with invoice IDs if generated
      if (invoiceResult.invoices && invoiceResult.invoices.length > 0) {
        booking.invoiceIds = invoiceResult.invoices;
        await env.BOOKINGS.put(bookingId, JSON.stringify(booking), {
          expirationTtl: 60 * 60 * 24 * 90,
        });
      }
    } catch (invoiceError) {
      // Log but don't fail the booking
      console.error('Invoice generation failed (non-fatal):', invoiceError);
      booking.invoiceGenerationFailed = true;
      booking.invoiceError = invoiceError.message;
      await env.BOOKINGS.put(bookingId, JSON.stringify(booking), {
        expirationTtl: 60 * 60 * 24 * 90,
      });
    }

    // Build time slot label for email
    let timeSlotLabel;
    if (hasLegacyFormat && selectedSlot) {
      timeSlotLabel = selectedSlot.label;
    } else if (hasNewFormat) {
      timeSlotLabel = `${body.startTime}${body.endTime ? ' – ' + body.endTime : ''}`;
    } else {
      timeSlotLabel = 'Time not specified';
    }

    // Route to correct Apps Script email action
    if (isStudioViewing(booking)) {
      // Open house viewing — send simple slot confirmation, no invoice
      await triggerAppsScript('open_house', {
        bookingId: booking.id,
        clientName: booking.name,
        clientEmail: booking.email,
        clientPhone: booking.phone,
        eventDate: booking.date,
        timeSlot: timeSlotLabel,
        notes: booking.notes || '',
      }, env, { testMode });
    } else if (!env.RESEND_API_KEY) {
      // Regular booking — fallback to Apps Script invoice email if Resend not configured
      await triggerAppsScript('invoice', {
        bookingId: booking.id,
        clientName: booking.name,
        clientEmail: booking.email,
        clientPhone: booking.phone,
        eventType: booking.eventType,
        eventDate: booking.date,
        timeSlot: timeSlotLabel,
        guestCount: booking.guestCount,
        total: booking.total,
        deposit: booking.deposit,
      }, env, { testMode });
    }

    return json({
      success: true,
      bookingId: booking.id,
      // Legacy fields for frontend compatibility
      deposit: booking.hireDeposit || booking.deposit,
      total: booking.hireTotal || booking.total,
      // Detailed breakdown
      hireTotal: booking.hireTotal || booking.total,
      hireDeposit: booking.hireDeposit || booking.deposit,
      damageDeposit: booking.damageDeposit || 0,
      totalDueNow: (booking.hireDeposit || booking.deposit) + (booking.damageDeposit || 0),
      invoices: invoiceResult.invoices || [],
      invoiceEmailSent: invoiceResult.success || false,
      testMode,
      bankDetails: {
        accountName: BUSINESS_DETAILS.bank.name,
        sortCode: BUSINESS_DETAILS.bank.sortCode,
        accountNumber: BUSINESS_DETAILS.bank.accountNumber,
        reference: booking.id,
      },
    });

  } catch (error) {
    console.error('Booking creation failed:', error);
    return json({ error: 'Failed to create booking' }, 500);
  }
});

// Get booking status
router.get('/api/bookings/:id', async (request, env) => {
  const { id } = request.params;

  const bookingData = await env.BOOKINGS.get(id);
  if (!bookingData) {
    return json({ error: 'Booking not found' }, 404);
  }

  const booking = JSON.parse(bookingData);
  return json({
    id: booking.id,
    status: booking.status,
    eventType: booking.eventType,
    date: booking.date,
    total: booking.total,
    deposit: booking.deposit,
  });
});

// Confirm a booking (called from admin dashboard)
router.post('/api/bookings/:id/confirm', async (request, env) => {
  const { id } = request.params;
  const testMode = isTestMode(request);

  // Check admin auth (Cloudflare Access JWT, cookie, or header)
  const cfAccessJwt = request.headers.get('Cf-Access-Jwt-Assertion');
  const authCookie = request.headers.get('Cookie')?.match(/hb_admin_key=([^;]+)/)?.[1];
  const authHeader = request.headers.get('Authorization')?.replace('Bearer ', '');

  if (!cfAccessJwt && authCookie !== env.ADMIN_KEY && authHeader !== env.ADMIN_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const bookingData = await env.BOOKINGS.get(id);
  if (!bookingData) {
    return json({ error: 'Booking not found' }, 404);
  }

  const booking = JSON.parse(bookingData);

  if (booking.status === 'confirmed') {
    return json({ error: 'Booking already confirmed' }, 400);
  }

  // Update calendar event
  await confirmEvent(booking.calendarEventId, booking, env);

  // Update booking status
  booking.status = 'confirmed';
  booking.confirmedAt = new Date().toISOString();
  await env.BOOKINGS.put(id, JSON.stringify(booking));

  // Send confirmation email (skipped in test mode)
  await triggerAppsScript('confirmation', {
    bookingId: booking.id,
    clientName: booking.name,
    clientEmail: booking.email,
    eventType: booking.eventType,
    eventDate: booking.date,
  }, env, { testMode });

  return json({ success: true, message: 'Booking confirmed', testMode });
});

// Send invoice for manual booking (admin only)
router.post('/api/bookings/:id/send-invoice', async (request, env) => {
  const { id } = request.params;
  const testMode = isTestMode(request);

  // Check admin auth
  const authHeader = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (authHeader !== env.ADMIN_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const bookingData = await env.BOOKINGS.get(id);
  if (!bookingData) {
    return json({ error: 'Booking not found' }, 404);
  }

  const booking = JSON.parse(bookingData);

  // Create calendar event if not exists
  if (!booking.calendarEventId) {
    try {
      const calendarEvent = await createProvisionalEvent(booking, env);
      booking.calendarEventId = calendarEvent.id;
      await env.BOOKINGS.put(id, JSON.stringify(booking));
    } catch (calError) {
      console.error('Calendar event creation failed:', calError);
      // Continue to send invoice anyway
    }
  }

  // Send invoice via Apps Script
  await triggerAppsScript('invoice', {
    bookingId: booking.id,
    clientName: booking.name,
    clientEmail: booking.email,
    secondaryEmail: booking.secondaryEmail,
    clientPhone: booking.phone,
    eventType: booking.eventType,
    eventDate: booking.date,
    timeSlot: `${booking.startTime} - ${booking.endTime}`,
    guestCount: booking.guestCount,
    total: booking.total,
    deposit: booking.deposit,
  }, env, { testMode });

  return json({
    success: true,
    message: 'Invoice sent',
    bookingId: booking.id,
    total: booking.total,
    deposit: booking.deposit,
    testMode
  });
});

// Delete calendar event (admin only) - for cleanup
router.delete('/api/calendar/:eventId', async (request, env) => {
  const { eventId } = request.params;

  // Admin only
  const authHeader = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (authHeader !== env.ADMIN_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  try {
    const success = await deleteCalendarEvent(eventId, env);
    if (success) {
      return json({ success: true, message: `Deleted calendar event ${eventId}` });
    } else {
      return json({ error: 'Failed to delete event' }, 500);
    }
  } catch (error) {
    console.error('Calendar delete failed:', error);
    return json({ error: error.message }, 500);
  }
});

// Cancel a booking (policy-aware)
router.post('/api/bookings/:id/cancel', async (request, env) => {
  const { id } = request.params;
  const testMode = isTestMode(request);

  // Check admin auth (Cloudflare Access JWT, cookie, or header)
  const cfAccessJwt = request.headers.get('Cf-Access-Jwt-Assertion');
  const authCookie = request.headers.get('Cookie')?.match(/hb_admin_key=([^;]+)/)?.[1];
  const authHeader = request.headers.get('Authorization')?.replace('Bearer ', '');

  if (!cfAccessJwt && authCookie !== env.ADMIN_KEY && authHeader !== env.ADMIN_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const bookingData = await env.BOOKINGS.get(id);
  if (!bookingData) {
    return json({ error: 'Booking not found' }, 404);
  }

  const booking = JSON.parse(bookingData);

  // Calculate days until event
  const eventDate = new Date(booking.date);
  const today = getLondonToday();
  const daysUntil = Math.ceil((eventDate - today) / (1000 * 60 * 60 * 24));

  // Determine refund based on policy AND actual payment status
  let refundAmount = 0;
  let refundType = 'none';
  let policyMessage = '';

  // Check actual payment status
  const depositActuallyPaid = booking.depositPaid === true;
  const balanceActuallyPaid = booking.balancePaid === true;

  if (!depositActuallyPaid) {
    // No deposit paid - nothing to forfeit or refund
    policyMessage = `Cancelled with ${daysUntil} days notice. No deposit was received, so no refund is due.`;
  } else if (daysUntil >= 7) {
    // 7+ days: deposit forfeited, balance refunded if paid
    if (balanceActuallyPaid) {
      refundAmount = (booking.total || 0) - (booking.deposit || 0);
      refundType = 'balance';
      policyMessage = `Cancelled with ${daysUntil} days notice. Deposit (£${booking.deposit}) forfeited. Balance (£${refundAmount}) to be refunded.`;
    } else {
      policyMessage = `Cancelled with ${daysUntil} days notice. Deposit (£${booking.deposit}) forfeited. No additional refund due.`;
    }
  } else {
    // <7 days: everything forfeited
    if (balanceActuallyPaid) {
      policyMessage = `Cancelled with ${daysUntil} days notice. Per our policy, no refund is available for cancellations with less than 7 days notice. Total amount (£${booking.total}) forfeited.`;
    } else {
      policyMessage = `Cancelled with ${daysUntil} days notice. Per our policy, no refund is available for cancellations with less than 7 days notice. Deposit (£${booking.deposit}) forfeited.`;
    }
  }

  // Delete calendar event
  try {
    await deleteCalendarEvent(booking.calendarEventId, env);
  } catch (error) {
    console.error('Failed to delete calendar event:', error);
  }

  // Update booking status
  booking.status = 'cancelled';
  booking.cancelledAt = new Date().toISOString();
  booking.cancellationPolicy = { daysUntil, refundAmount, refundType };
  await env.BOOKINGS.put(id, JSON.stringify(booking));

  // Send cancellation email (skipped in test mode)
  await triggerAppsScript('cancellation', {
    bookingId: booking.id,
    clientName: booking.name,
    clientEmail: booking.email,
    eventType: booking.eventType,
    eventDate: booking.date,
    refundAmount,
    refundType,
    policyMessage,
    requestBankDetails: refundAmount > 0,
  }, env, { testMode });

  return json({
    success: true,
    message: 'Booking cancelled',
    testMode,
    policy: { daysUntil, refundAmount, refundType, policyMessage },
  });
});

// Change booking date (policy-aware)
router.post('/api/bookings/:id/change-date', async (request, env) => {
  const { id } = request.params;
  const testMode = isTestMode(request);

  // Check admin auth (Cloudflare Access JWT, cookie, or header)
  const cfAccessJwt = request.headers.get('Cf-Access-Jwt-Assertion');
  const authCookie = request.headers.get('Cookie')?.match(/hb_admin_key=([^;]+)/)?.[1];
  const authHeader = request.headers.get('Authorization')?.replace('Bearer ', '');

  if (!cfAccessJwt && authCookie !== env.ADMIN_KEY && authHeader !== env.ADMIN_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const body = await request.json();
  const { newDate, newTimeSlot } = body;

  if (!newDate || !newTimeSlot) {
    return json({ error: 'newDate and newTimeSlot are required' }, 400);
  }

  const bookingData = await env.BOOKINGS.get(id);
  if (!bookingData) {
    return json({ error: 'Booking not found' }, 404);
  }

  const booking = safeJsonParse(bookingData);

  // Check if this is the second change (treat as cancellation)
  if (booking.dateChangeCount >= 1) {
    return json({
      error: 'second_change',
      message: 'This is the second date change request. Per policy, this should be treated as a cancellation.',
    }, 400);
  }

  // Calculate days until original event
  const eventDate = new Date(booking.date);
  const today = getLondonToday();
  const daysUntil = Math.ceil((eventDate - today) / (1000 * 60 * 60 * 24));

  // Determine fee
  let changeFee = 0;
  let feeMessage = '';

  if (daysUntil >= 7) {
    feeMessage = 'Free date change (7+ days notice).';
  } else {
    changeFee = 50;
    feeMessage = `£50 rebooking fee applies (${daysUntil} days notice).`;
  }

  // Check new slot availability using the booking's duration
  const duration = booking.duration ? parseInt(booking.duration) : null;
  const slots = await checkAvailability(newDate, env, false, duration);
  const selectedSlot = slots.find(s => s.id === newTimeSlot);

  if (!selectedSlot?.available) {
    const alternatives = slots.filter(s => s.available).slice(0, 3);
    return json({
      error: 'slot_unavailable',
      message: 'The requested slot is not available.',
      alternatives,
    }, 409);
  }

  // Delete old calendar event
  try {
    await deleteCalendarEvent(booking.calendarEventId, env);
  } catch (error) {
    console.error('Failed to delete old calendar event:', error);
  }

  // Update booking with new date and time
  const oldDate = booking.date;
  booking.date = newDate;
  // Update start/end times from selected slot (preserves duration)
  booking.startTime = selectedSlot.start;
  booking.endTime = selectedSlot.end;
  booking.timeSlot = newTimeSlot;
  booking.dateChangeCount = (booking.dateChangeCount || 0) + 1;
  booking.dateChangeHistory = booking.dateChangeHistory || [];
  booking.dateChangeHistory.push({
    from: oldDate,
    to: newDate,
    fee: changeFee,
    changedAt: new Date().toISOString(),
  });

  // Create new calendar event
  const calendarEvent = await createProvisionalEvent({
    ...booking,
    id: booking.id,
  }, env);
  booking.calendarEventId = calendarEvent.id;

  // If booking was confirmed, update new event to confirmed
  if (booking.status === 'confirmed') {
    await confirmEvent(booking.calendarEventId, booking, env);
  }

  await env.BOOKINGS.put(id, JSON.stringify(booking));

  // Send date change email (skipped in test mode)
  await triggerAppsScript('date_change', {
    bookingId: booking.id,
    clientName: booking.name,
    clientEmail: booking.email,
    eventType: booking.eventType,
    oldDate,
    newDate,
    newTimeSlot: selectedSlot.label,
    changeFee,
    feeMessage,
  }, env, { testMode });

  return json({
    success: true,
    message: 'Date changed successfully',
    testMode,
    policy: { daysUntil, changeFee, feeMessage },
    newDate,
    newTimeSlot,
  });
});

// ============================================
// Payment Tracking Endpoints
// ============================================

// Mark deposit as paid
router.post('/api/bookings/:id/mark-deposit-paid', async (request, env) => {
  const { id } = request.params;
  const data = await env.BOOKINGS.get(id);

  if (!data) {
    return json({ error: 'Booking not found' }, 404);
  }

  const booking = JSON.parse(data);

  if (booking.depositPaid) {
    return json({ error: 'Deposit already marked as paid' }, 400);
  }

  booking.depositPaid = true;
  booking.depositPaidAt = new Date().toISOString();

  await env.BOOKINGS.put(id, JSON.stringify(booking));

  return json({
    success: true,
    message: 'Deposit marked as paid',
    booking: {
      id: booking.id,
      depositPaid: booking.depositPaid,
      depositPaidAt: booking.depositPaidAt,
    },
  });
});

// Mark balance as paid
router.post('/api/bookings/:id/mark-balance-paid', async (request, env) => {
  const { id } = request.params;
  const data = await env.BOOKINGS.get(id);

  if (!data) {
    return json({ error: 'Booking not found' }, 404);
  }

  const booking = JSON.parse(data);

  if (!booking.depositPaid) {
    return json({ error: 'Cannot mark balance paid before deposit is paid' }, 400);
  }

  if (booking.balancePaid) {
    return json({ error: 'Balance already marked as paid' }, 400);
  }

  booking.balancePaid = true;
  booking.balancePaidAt = new Date().toISOString();

  await env.BOOKINGS.put(id, JSON.stringify(booking));

  return json({
    success: true,
    message: 'Balance marked as paid',
    booking: {
      id: booking.id,
      balancePaid: booking.balancePaid,
      balancePaidAt: booking.balancePaidAt,
    },
  });
});

// ============================================
// Admin Routes
// ============================================

// Admin login (sets cookie)
router.get('/admin/login', async (request, env) => {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (key !== env.ADMIN_KEY) {
    return html('<h1>Invalid admin key</h1>', 401);
  }

  // Set secure cookie and redirect to admin
  return new Response(null, {
    status: 302,
    headers: {
      'Set-Cookie': `hb_admin_key=${key}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
      'Location': '/admin',
    },
  });
});

// Admin dashboard
// TEMP DEBUG - remove after testing
router.get('/admin/v2debug', async (request, env) => {
  const bookingsList = await env.BOOKINGS.list();
  const kvBookings = [];
  for (const key of bookingsList.keys) {
    if (key.name.startsWith('invoice:') || key.name.startsWith('INVOICE_COUNTER')) continue;
    const data = await env.BOOKINGS.get(key.name);
    if (data) { try { const b = JSON.parse(data); b.fromKV = true; b.id = key.name; kvBookings.push(b); } catch(e) {} }
  }
  const testHtml = generateAdminDashboardV2(kvBookings, { calendarEventsCount: 0 });
  const scriptBlocks = testHtml.match(/<script>[\s\S]*?<\/script>/g) || [];
  const second = scriptBlocks[1] || 'NO SECOND SCRIPT';
  return new Response('SCRIPT BLOCKS: ' + scriptBlocks.length + '\n\nSECOND BLOCK (first 2000 chars):\n' + second.substring(0, 2000), { headers: { 'Content-Type': 'text/plain' } });
});

router.get('/admin', async (request, env) => {
  // Check auth - accept EITHER Cloudflare Access JWT OR legacy cookie
  const cfAccessJwt = request.headers.get('Cf-Access-Jwt-Assertion');
  const authCookie = request.headers.get('Cookie')?.match(/hb_admin_key=([^;]+)/)?.[1];

  // If Cloudflare Access JWT is present, user came through Zero Trust (trusted)
  // Otherwise fall back to legacy cookie auth
  const isAuthenticated = cfAccessJwt || (authCookie === env.ADMIN_KEY);

  if (!isAuthenticated) {
    return html(`
      <html>
        <head><title>Hibiscus Studio Admin - Login Required</title></head>
        <body style="font-family: system-ui; padding: 40px; text-align: center;">
          <h1>Admin Access Required</h1>
          <p>Please use your admin login link to access this page.</p>
        </body>
      </html>
    `, 401);
  }

  // Track if we need to set cookie (user came through Cloudflare Access but no cookie yet)
  const needsAuthCookie = cfAccessJwt && !authCookie;

  try {

  // Get bookings from KV (filter out invoice records and counters)
  const bookingsList = await env.BOOKINGS.list();
  const kvBookings = [];
  const kvCalendarIds = new Set();
  const kvNameDates = new Set();
  const kvEmailDates = new Set();

  for (const key of bookingsList.keys) {
    // Skip non-booking keys (invoices, counters, etc.)
    if (key.name.startsWith('invoice:') || key.name.startsWith('INVOICE_COUNTER')) {
      continue;
    }

    const data = await env.BOOKINGS.get(key.name);
    if (data) {
      try {
        const booking = safeJsonParse(data);
        booking.fromKV = true;
        kvBookings.push(booking);
        if (booking.calendarEventId) {
          kvCalendarIds.add(booking.calendarEventId);
        }
        if (booking.name && booking.date) {
          kvNameDates.add(`${booking.name.toLowerCase().trim()}|${booking.date}`);
        }
        if (booking.email && booking.date) {
          kvEmailDates.add(`${booking.email.toLowerCase().trim()}|${booking.date}`);
        }
      } catch (parseErr) {
        console.error(`Skipping corrupted KV entry ${key.name}:`, parseErr.message, 'Raw data starts with:', data.substring(0, 100));
      }
    }
  }

  // Get ALL calendar events from both calendars
  let calendarEvents = [];
  try {
    calendarEvents = await getAllCalendarEvents(env);
  } catch (error) {
    console.error('Failed to fetch calendar events:', error);
  }

  // Filter out calendar events that already exist in KV (avoid duplicates)
  // Match by calendarEventId, name+date, or email+date
  const uniqueCalendarEvents = calendarEvents.filter(event => {
    if (kvCalendarIds.has(event.calendarEventId)) return false;
    if (event.name && event.date) {
      const key = `${event.name.toLowerCase().trim()}|${event.date}`;
      if (kvNameDates.has(key)) return false;
    }
    if (event.email && event.date) {
      const key = `${event.email.toLowerCase().trim()}|${event.date}`;
      if (kvEmailDates.has(key)) return false;
    }
    return true;
  });

  // Merge: KV bookings + unique calendar events
  const allBookings = [...kvBookings, ...uniqueCalendarEvents];

  // Sort by event date (upcoming first), then by created date
  allBookings.sort((a, b) => {
    const dateA = new Date(a.date || a.startTime || '2099-12-31');
    const dateB = new Date(b.date || b.startTime || '2099-12-31');
    return dateA - dateB;
  });

  try {
    const adminUrl = new URL(request.url);
    const useV2 = adminUrl.searchParams.get('v') === '2';
    const isDebug = adminUrl.searchParams.get('debug') === '1';
    const dashboardHtml = useV2
      ? generateAdminDashboardV2(allBookings, { calendarEventsCount: calendarEvents.length })
      : generateAdminDashboard(allBookings, { calendarEventsCount: calendarEvents.length });
    if (isDebug && useV2) {
      const scriptMatch = dashboardHtml.match(/<script>[\s\S]*?window\.__v2ScriptLoaded[\s\S]*?<\/script>/);
      return new Response(scriptMatch ? scriptMatch[0] : 'NO MATCH - total length: ' + dashboardHtml.length, { headers: { 'Content-Type': 'text/plain' } });
    }
    const headers = { ...corsHeaders, 'Content-Type': 'text/html' };

    // Set cookie for Cloudflare Access users so API calls work
    if (needsAuthCookie) {
      headers['Set-Cookie'] = `hb_admin_key=${env.ADMIN_KEY}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`;
    }

    return new Response(dashboardHtml, { status: 200, headers });
  } catch (error) {
    console.error('Dashboard generation error:', error);
    return html(`
      <html>
        <head><title>Hibiscus Studio - Error</title></head>
        <body style="font-family: system-ui; padding: 40px;">
          <h1>Dashboard Error</h1>
          <p><strong>Error:</strong> ${error.message}</p>
          <p><strong>Stack:</strong></p>
          <pre style="background: #f5f5f5; padding: 15px; overflow: auto;">${error.stack}</pre>
          <p><strong>Bookings count:</strong> ${allBookings.length}</p>
          <p><strong>Sample booking dates:</strong></p>
          <ul>
            ${allBookings.slice(0, 5).map(b => `<li>${b.name || 'No name'}: date=${JSON.stringify(b.date)}</li>`).join('')}
          </ul>
        </body>
      </html>
    `, 500);
  }

  } catch (outerError) {
    return new Response(`<html><body><h1>ADMIN CRASH DEBUG</h1><pre>${outerError.message}\n\n${outerError.stack}</pre></body></html>`, {
      status: 500,
      headers: { 'Content-Type': 'text/html' }
    });
  }
});

// Create calendar event for a KV booking that's missing one
router.post('/api/admin/bookings/:id/sync-calendar', async (request, env) => {
  const cfAccessJwt = request.headers.get('Cf-Access-Jwt-Assertion');
  const authCookie = request.headers.get('Cookie')?.match(/hb_admin_key=([^;]+)/)?.[1];
  const authHeader = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!cfAccessJwt && authCookie !== env.ADMIN_KEY && authHeader !== env.ADMIN_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const { id } = request.params;
  const data = await env.BOOKINGS.get(id);
  if (!data) return json({ error: 'Booking not found' }, 404);

  const booking = safeJsonParse(data);
  try {
    const calendarEvent = await createProvisionalEvent(booking, env);
    booking.calendarEventId = calendarEvent.id;
    await env.BOOKINGS.put(id, JSON.stringify(booking));
    return json({ success: true, calendarEventId: calendarEvent.id });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
});

// Get pending bookings as JSON (for AJAX refresh)
router.get('/api/admin/pending', async (request, env) => {
  // Check admin auth (Cloudflare Access JWT, cookie, or header)
  const cfAccessJwt = request.headers.get('Cf-Access-Jwt-Assertion');
  const authCookie = request.headers.get('Cookie')?.match(/hb_admin_key=([^;]+)/)?.[1];
  const authHeader = request.headers.get('Authorization')?.replace('Bearer ', '');

  if (!cfAccessJwt && authCookie !== env.ADMIN_KEY && authHeader !== env.ADMIN_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const bookingsList = await env.BOOKINGS.list();
  const pendingBookings = [];

  for (const key of bookingsList.keys) {
    // Skip non-booking keys (invoices, counters, etc.)
    if (key.name.startsWith('invoice:') || key.name.startsWith('INVOICE_COUNTER')) {
      continue;
    }

    const data = await env.BOOKINGS.get(key.name);
    if (data) {
      try {
        const booking = safeJsonParse(data);
        if (booking.status === 'pending') {
          pendingBookings.push(booking);
        }
      } catch (e) {
        console.error(`Skipping corrupted pending entry ${key.name}`);
      }
    }
  }

  pendingBookings.sort((a, b) => new Date(a.date) - new Date(b.date));

  return json({ bookings: pendingBookings });
});

// ============================================
// Admin Dashboard HTML
// ============================================

function generateAdminDashboard(bookings, options = {}) {
  // Calculate stats - always use London timezone
  const now = getLondonNow();
  const currentYear = now.getFullYear();

  // Separate sources
  const kvBookings = bookings.filter(b => b.fromKV);
  const calendarOnlyBookings = bookings.filter(b => b.fromCalendar && !b.fromKV);

  // Calculate upcoming bookings (future dates, not cancelled)
  const today = getLondonToday();
  const upcomingBookings = bookings.filter(b => {
    const eventDate = new Date(b.date);
    return eventDate >= today && b.status !== 'cancelled';
  });

  // Revenue only from bookings with actual price data
  const confirmedWithPrice = bookings.filter(b =>
    b.status === 'confirmed' && b.total && b.total > 0
  );
  const ytdConfirmedWithPrice = confirmedWithPrice.filter(b => {
    const eventDate = new Date(b.date);
    return eventDate.getFullYear() === currentYear;
  });

  // Recent activity: past 7 days and next 7 days
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenDaysFromNow = new Date(today);
  sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

  const pastWeekEvents = bookings.filter(b => {
    const d = new Date(b.date);
    return d >= sevenDaysAgo && d < today && b.status !== 'cancelled';
  });

  const nextWeekEvents = bookings.filter(b => {
    const d = new Date(b.date);
    return d >= today && d <= sevenDaysFromNow && b.status !== 'cancelled';
  });

  // Event type breakdown for next 7 days
  const nextWeekByType = {};
  nextWeekEvents.forEach(b => {
    const type = b.eventType || 'Other';
    nextWeekByType[type] = (nextWeekByType[type] || 0) + 1;
  });

  const stats = {
    total: bookings.length,
    pending: bookings.filter(b => b.status === 'pending').length,
    confirmed: bookings.filter(b => b.status === 'confirmed').length,
    cancelled: bookings.filter(b => b.status === 'cancelled').length,
    fromKV: kvBookings.length,
    fromCalendar: calendarOnlyBookings.length,
    upcoming: upcomingBookings.length,
    upcomingConfirmed: upcomingBookings.filter(b => b.status === 'confirmed').length,
    pastWeek: pastWeekEvents.length,
    nextWeek: nextWeekEvents.length,
    nextWeekByType: nextWeekByType,
    ytdBookings: bookings.filter(b => {
      const eventDate = new Date(b.date);
      return eventDate.getFullYear() === currentYear && b.status !== 'cancelled';
    }).length,
    // Only count revenue from bookings with actual price data
    ytdRevenue: ytdConfirmedWithPrice.reduce((sum, b) => sum + b.total, 0),
    ytdRevenueCount: ytdConfirmedWithPrice.length, // How many have price data
    monthlyBreakdown: {},
  };

  // Calculate monthly breakdown for current year (using event date, not created date)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  months.forEach((m, i) => { stats.monthlyBreakdown[m] = 0; });

  bookings.filter(b => {
    const eventDate = new Date(b.date);
    return eventDate.getFullYear() === currentYear && b.status !== 'cancelled';
  }).forEach(b => {
    const month = months[new Date(b.date).getMonth()];
    if (month) stats.monthlyBreakdown[month]++;
  });

  // Generate booking cards - grouped by PAYMENT STATUS, not booking status
  // Awaiting Deposit: pending bookings where depositPaid = false (or undefined for legacy)
  const awaitingDepositBookings = bookings.filter(b =>
    b.status === 'pending' && !b.depositPaid
  ).sort((a, b) => new Date(a.date) - new Date(b.date));

  // Deposit Paid: pending bookings where depositPaid = true but not yet confirmed
  const depositPaidBookings = bookings.filter(b =>
    b.status === 'pending' && b.depositPaid === true
  ).sort((a, b) => new Date(a.date) - new Date(b.date));

  // Confirmed: confirmed bookings (may or may not have balancePaid)
  const confirmedBookings = bookings.filter(b => b.status === 'confirmed').sort((a, b) => new Date(a.date) - new Date(b.date));

  // Balance Due: confirmed API bookings where balance not yet paid (only count ones we track)
  const balanceDueBookings = bookings.filter(b =>
    b.status === 'confirmed' && b.fromKV && !b.balancePaid
  );

  // Legacy aliases for any code that still uses these
  const pendingBookings = bookings.filter(b => b.status === 'pending').sort((a, b) => new Date(a.date) - new Date(b.date));
  const cancelledBookings = bookings.filter(b => b.status === 'cancelled').sort((a, b) => new Date(b.cancelledAt) - new Date(a.cancelledAt));

  // =============================================
  // ROLLUP METRICS for header
  // =============================================

  // This week: confirmed events + revenue + hours
  const weekEnd = new Date(today);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const thisWeekBookings = bookings.filter(b => {
    const d = new Date(b.date);
    return d >= today && d < weekEnd && b.status !== 'cancelled';
  });

  const weekConfirmed = thisWeekBookings.filter(b => b.status === 'confirmed');
  const weekRevenue = weekConfirmed.reduce((sum, b) => sum + (b.total || 0), 0);

  // This month: confirmed revenue
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

  const thisMonthConfirmed = bookings.filter(b => {
    const d = new Date(b.date);
    return d >= monthStart && d <= monthEnd && b.status === 'confirmed';
  });
  const monthRevenue = thisMonthConfirmed.reduce((sum, b) => sum + (b.total || 0), 0);

  // Month name
  const monthName = today.toLocaleString('en-GB', { month: 'short' });

  // Event type color coding
  function getEventTypeClass(eventType) {
    if (!eventType) return '';
    const type = eventType.toLowerCase();
    if (type.includes('birthday')) return 'type-birthday';
    if (type.includes('bridal') || type.includes('hen')) return 'type-bridal';
    if (type.includes('baby') || type.includes('shower')) return 'type-baby';
    if (type.includes('workshop') || type.includes('class')) return 'type-workshop';
    if (type.includes('corporate') || type.includes('business')) return 'type-corporate';
    if (type.includes('photo') || type.includes('shoot')) return 'type-photo';
    return 'type-other';
  }

  // NEW: Action-first card design with inline confirm and source badge
  function generateBookingCard(b) {
    // Guard against null/undefined dates that would crash toISOString()
    if (!b.date) {
      return ''; // Skip bookings with no date
    }

    const eventDate = new Date(b.date);

    // Check for invalid date (NaN)
    if (isNaN(eventDate.getTime())) {
      return ''; // Skip invalid dates
    }

    const today = getLondonToday();
    const daysUntil = Math.ceil((eventDate - today) / (1000 * 60 * 60 * 24));
    const dateChangeCount = b.dateChangeCount || 0;
    const isPending = b.status === 'pending';
    const isConfirmed = b.status === 'confirmed';
    const isCancelled = b.status === 'cancelled';
    const isCalendarOnly = b.fromCalendar && !b.fromKV;
    const isLegacy = b.calendarSource === 'hibiscusstudiouk';

    const statusClass = isPending ? 'pending' : isConfirmed ? 'confirmed' : 'cancelled';
    const daysLabel = daysUntil > 0 ? `${daysUntil}d` : daysUntil === 0 ? 'Today' : 'Past';
    const daysClass = daysUntil <= 2 ? 'urgent' : daysUntil <= 7 ? 'soon' : '';

    // Deposit aging — how long has this pending booking been waiting?
    let agingBadge = '';
    if (isPending && !b.depositPaid && b.createdAt) {
      const hoursSince = Math.floor((Date.now() - new Date(b.createdAt).getTime()) / (1000 * 60 * 60));
      if (hoursSince >= 48) {
        agingBadge = `<span class="aging-badge aging-critical">⚠ ${hoursSince}h — no deposit</span>`;
      } else if (hoursSince >= 24) {
        agingBadge = `<span class="aging-badge aging-warn">${hoursSince}h — no deposit</span>`;
      }
    }

    // Source badge text and class
    const sourceText = isCalendarOnly ? (isLegacy ? 'Legacy' : 'Cal') : 'API';
    const sourceClass = isCalendarOnly ? (isLegacy ? 'legacy' : 'cal') : 'api';

    // Month key for filtering (e.g., "2025-01")
    const monthKey = eventDate.toISOString().slice(0, 7);

    return `
    <article class="card ${statusClass}" data-id="${b.id}" data-status="${b.status}" data-month="${monthKey}">
      <div class="card-row">
        <div class="card-content">
          <div class="card-header">
            <h3 class="card-name">${b.name || 'Unknown'}</h3>
            <span class="source-badge ${sourceClass}">${sourceText}</span>
          </div>
          <div class="card-info">
            <time class="card-date">${formatDate(b.date)}</time>
            ${b.total ? `<span class="card-sep">·</span><span class="card-price">£${b.total}</span>` : ''}
            ${!isCancelled ? `<span class="days-badge ${daysClass}">${daysLabel}</span>` : ''}
          </div>
          <div class="card-meta">
            <span class="event-badge ${getEventTypeClass(b.eventType)}">${b.eventType || 'Event'}</span>
            ${b.guestCount ? `<span class="guest-badge">${b.guestCount} guests</span>` : ''}
            ${agingBadge}
          </div>
        </div>

        ${isPending && !isCalendarOnly ? `
        <button class="inline-confirm" onclick="confirmBooking('${b.id}')">
          <svg class="confirm-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
          <span class="confirm-text">Confirm</span>
        </button>
        ` : ''}
      </div>

      ${b.email || b.phone ? `
      <div class="card-contact">
        ${b.email ? `<a href="mailto:${b.email}">${b.email}</a>` : ''}
        ${b.phone ? `<a href="tel:${b.phone}">${b.phone}</a>` : ''}
      </div>
      ` : ''}

      ${!isCancelled ? `
      <div class="card-actions">
        <button class="btn-secondary" onclick="showChangeDateModal('${b.id}', '${b.date}', ${daysUntil}, ${dateChangeCount}, ${b.duration || 6})">
          Reschedule
        </button>
        <button class="btn-danger" onclick="showCancelModal('${b.id}', '${b.name}', '${b.date}', ${daysUntil}, ${b.deposit || 150}, ${b.total || 300}, ${isCalendarOnly})">
          Cancel
        </button>
        ${isCalendarOnly && b.name && b.date ? `
        <a href="${getCalendarSearchUrl(b.name, b.date)}" target="_blank" rel="noopener" class="btn-link">
          Open in Calendar
        </a>
        ` : ''}
      </div>
      ` : ''}

      ${isCancelled ? `
      <p class="cancelled-note">Cancelled ${formatDate(b.cancelledAt)}${b.cancellationPolicy?.refundAmount > 0 ? ` · Refund: £${b.cancellationPolicy.refundAmount}` : ''}</p>
      ` : ''}
    </article>
  `;
  }

  // =============================================
  // CALENDAR-FIRST: Group bookings by day
  // =============================================

  // Get all non-cancelled bookings for calendar view
  const allActiveBookings = bookings.filter(b => b.status !== 'cancelled');

  // Dedupe synced events - prefer new calendar (fromKV/API) over legacy
  const seenKeys = new Map(); // key -> booking (prefer new calendar)
  const hideIds = new Set();  // IDs to hide (duplicates)
  const duplicateIds = new Set();  // IDs that are duplicates (for badge display)
  const syncedIds = new Set();     // IDs synced across calendars (for badge display)

  allActiveBookings.forEach(b => {
    try {
      const name = (b.name || '').toLowerCase().trim();
      if (!b.date) return; // Skip bookings with no date
      const dateObj = new Date(b.date);
      if (isNaN(dateObj.getTime())) return; // Skip invalid dates
      const date = dateObj.toISOString().slice(0, 10);
      const key = name + '-' + date;
      const isNew = b.fromKV || b.calendarSource === 'hibiscusstudiolondon';

      if (seenKeys.has(key)) {
        const existing = seenKeys.get(key);
        const existingIsNew = existing.fromKV || existing.calendarSource === 'hibiscusstudiolondon';

        if (isNew && !existingIsNew) {
          // This one is newer, hide the old one
          hideIds.add(existing.id);
          seenKeys.set(key, b);
        } else {
          // Keep existing, hide this one
          hideIds.add(b.id);
        }
      } else {
        seenKeys.set(key, b);
      }
    } catch (e) {
      // Skip this booking if any error
      console.error('Dedup error for booking:', b.id, e);
    }
  });

  // Filter out hidden duplicates
  const deduped = allActiveBookings.filter(b => !hideIds.has(b.id));

  // Create day buckets for next 7 days
  const dayBuckets = [];
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    const dateStr = date.toISOString().slice(0, 10);

    let label;
    if (i === 0) label = 'TODAY';
    else if (i === 1) label = 'TOMORROW';
    else label = dayNames[date.getDay()].toUpperCase();

    const dateLabel = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

    const dayBookings = deduped.filter(b => {
      if (!b.date) return false;
      try {
        const bDate = new Date(b.date).toISOString().slice(0, 10);
        return bDate === dateStr;
      } catch (e) { return false; }
    }).sort((a, b) => {
      // Sort by time if available
      const timeA = a.timeSlot || a.startTime || '00:00';
      const timeB = b.timeSlot || b.startTime || '00:00';
      return timeA.localeCompare(timeB);
    });

    dayBuckets.push({
      date: dateStr,
      label: label,
      dateLabel: dateLabel,
      isToday: i === 0,
      bookings: dayBookings
    });
  }

  // Get bookings beyond 7 days (for "Later" section)
  const sevenDaysFromNowStr = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const laterBookings = deduped.filter(b => {
    if (!b.date) return false;
    try {
      const bDate = new Date(b.date).toISOString().slice(0, 10);
      return bDate > sevenDaysFromNowStr;
    } catch (e) { return false; }
  }).sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, 10); // Show next 10

  // Clean up booking name (remove "Peerspace Booking, " prefix)
  function cleanName(name) {
    if (!name) return 'Unknown';
    return name.replace(/^Peerspace Booking,?\s*/i, '').trim() || name;
  }

  // Generate compact event row with expandable actions
  function generateEventRow(b) {
    const isPending = b.status === 'pending';
    const isConfirmed = b.status === 'confirmed';
    const isCalendarOnly = b.fromCalendar && !b.fromKV;
    const isDuplicate = duplicateIds.has(b.id);

    // Time display
    const timeDisplay = b.timeSlot || (b.startTime ? new Date(b.startTime).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'}) : '');

    // Calculate days until for actions
    const eventDate = new Date(b.date);
    const daysUntil = Math.ceil((eventDate - today) / (1000 * 60 * 60 * 24));

    // Status indicator (text only, no emoji)
    const statusText = isPending ? (b.depositPaid ? '○' : '◌') : '✓';
    const statusTitle = isPending ? (b.depositPaid ? 'Deposit paid' : 'Awaiting deposit') : 'Confirmed';

    // Google Calendar link for this day (use specific email if available, otherwise default)
    const gcalLink = getDirectCalendarUrl(b.calendarEventId, b.calendarEmail, b.date) || getCalendarDayUrl(b.date);

    return `
    <div class="event-row ${isPending ? 'pending' : 'confirmed'} ${isDuplicate ? 'duplicate' : ''}" data-id="${b.id}">
      <div class="event-time">${timeDisplay || '—'}</div>
      <div class="event-details">
        <span class="event-status ${isConfirmed ? 'confirmed' : ''}" title="${statusTitle}">${statusText}</span>
        <span class="event-name">${cleanName(b.name)}</span>
        <span class="event-badge ${getEventTypeClass(b.eventType)}">${b.eventType || 'Event'}</span>
        ${b.total ? `<span class="event-price">£${b.total}</span>` : ''}
      </div>
      <div class="event-actions">
        ${!isCalendarOnly ? `
          <button class="btn-row-action" onclick="showChangeDateModal('${b.id}', '${b.date}', ${daysUntil}, ${b.dateChangeCount || 0}, ${b.duration || 6})" title="Reschedule">↻</button>
          <button class="btn-row-action btn-row-danger" onclick="showCancelModal('${b.id}', '${b.name}', '${b.date}', ${daysUntil}, ${b.deposit || 150}, ${b.total || 300})" title="Cancel">✕</button>
          <a href="${gcalLink}" target="_blank" class="btn-row-action" title="View in Calendar">▸</a>
        ` : `
          <a href="${gcalLink}" target="_blank" class="cal-only-link" title="View in Google Calendar">Cal only ▸</a>
        `}
      </div>
    </div>
    `;
  }

  // Generate day section
  function generateDaySection(day) {
    const isEmpty = day.bookings.length === 0;
    return `
    <section class="day-section ${day.isToday ? 'today' : ''} ${isEmpty ? 'empty-day' : ''}">
      <div class="day-header">
        <span class="day-label">${day.label}${!isEmpty ? ` <span class="day-count">${day.bookings.length}</span>` : ''}</span>
        <span class="day-date">${day.dateLabel}</span>
      </div>
      <div class="day-events">
        ${isEmpty ? '<div class="no-events">No bookings</div>' : day.bookings.map(generateEventRow).join('')}
      </div>
    </section>
    `;
  }

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="theme-color" content="#0a0a0a">
  <title>Hibiscus Studio Admin</title>
  <style>
    /* ========================================
       CALENDAR-FIRST LAYOUT
       Day-by-day agenda view, Needs Action at top
       ======================================== */

    /* Spacing (shared) */
    :root {
      --sp-1: 4px;
      --sp-2: 8px;
      --sp-3: 12px;
      --sp-4: 16px;
      --sp-5: 20px;
      --sp-6: 24px;
      --touch-min: 44px;
      --header-height: 60px;
      --tabs-height: 52px;

      /* Typography */
      --text-xs: 0.6875rem;
      --text-sm: 0.8125rem;
      --text-base: 1rem;
      --text-lg: 1.125rem;
      --text-xl: 1.5rem;

      /* Borders & Radius */
      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 14px;
      --radius-full: 9999px;
    }

    /* Dark Mode (default) */
    :root, [data-theme="dark"] {
      --bg-base: #0a0a0a;
      --bg-surface: #141414;
      --bg-elevated: #1f1f1f;
      --text-primary: #fafafa;
      --text-secondary: #a3a3a3;
      --text-muted: #737373;
      --accent-primary: #404040;
      --accent-success: #fafafa;
      --accent-warning: #f59e0b;
      --accent-danger: #ef4444;
      --accent-info: #3b82f6;
      --border-subtle: 1px solid rgba(255,255,255,0.08);
      --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
      --shadow-md: 0 4px 12px rgba(0,0,0,0.4);
      --shadow-lg: 0 8px 24px rgba(0,0,0,0.5);
      --btn-confirm-text: #0a0a0a;
    }

    /* Light Mode - Notion-like */
    [data-theme="light"] {
      --bg-base: #ffffff;
      --bg-surface: #f7f7f5;
      --bg-elevated: #ffffff;
      --text-primary: #1a1a1a;
      --text-secondary: #6b6b6b;
      --text-muted: #9b9b9b;
      --accent-primary: #e0e0e0;
      --accent-success: #1a1a1a;
      --accent-warning: #d97706;
      --accent-danger: #dc2626;
      --accent-info: #2563eb;
      --border-subtle: 1px solid rgba(0,0,0,0.06);
      --shadow-sm: 0 1px 2px rgba(0,0,0,0.04);
      --shadow-md: 0 4px 12px rgba(0,0,0,0.08);
      --shadow-lg: 0 8px 24px rgba(0,0,0,0.12);
      --btn-confirm-text: #ffffff;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { font-size: 16px; -webkit-text-size-adjust: 100%; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
      background: var(--bg-base);
      color: var(--text-primary);
      line-height: 1.5;
      min-height: 100dvh;
    }

    /* ========================================
       STICKY HEADER with Pending Badge
       ======================================== */

    .header {
      position: sticky;
      top: 0;
      z-index: 100;
      background: var(--bg-base);
      border-bottom: var(--border-subtle);
      padding: var(--sp-3) var(--sp-4);
      display: flex;
      justify-content: space-between;
      align-items: center;
      height: var(--header-height);
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: var(--sp-3);
    }

    .logo {
      font-size: var(--text-lg);
      font-weight: 700;
      color: var(--text-primary);
    }

    .btn-refresh {
      background: var(--bg-surface);
      border: var(--border-subtle);
      border-radius: var(--radius-md);
      width: 36px;
      height: 36px;
      font-size: 18px;
      cursor: pointer;
      color: var(--text-secondary);
    }
    .btn-refresh:hover {
      background: var(--bg-elevated);
      color: var(--text-primary);
    }

    /* Theme Toggle */
    .btn-theme {
      background: var(--bg-surface);
      border: var(--border-subtle);
      border-radius: var(--radius-md);
      width: 36px;
      height: 36px;
      font-size: 16px;
      cursor: pointer;
      color: var(--text-secondary);
      transition: all 0.2s ease;
    }
    .btn-theme:hover {
      background: var(--bg-elevated);
      color: var(--text-primary);
    }
    .theme-icon-light { display: none; }
    .theme-icon-dark { display: inline; }
    [data-theme="light"] .theme-icon-light { display: inline; }
    [data-theme="light"] .theme-icon-dark { display: none; }

    .pending-badge {
      display: ${stats.pending > 0 ? 'flex' : 'none'};
      align-items: center;
      gap: var(--sp-1);
      background: var(--accent-warning);
      color: #000;
      padding: var(--sp-1) var(--sp-2);
      border-radius: var(--radius-full);
      font-size: var(--text-xs);
      font-weight: 700;
      animation: pulse-badge 2s infinite;
    }

    @keyframes pulse-badge {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: var(--sp-2);
    }

    .btn-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: var(--touch-min);
      height: var(--touch-min);
      background: var(--bg-surface);
      border: var(--border-subtle);
      border-radius: var(--radius-md);
      color: var(--text-secondary);
      font-size: var(--text-lg);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn-icon:hover { background: var(--bg-elevated); color: var(--text-primary); }
    .btn-icon:active { transform: scale(0.95); }

    .btn-info {
      flex-direction: column;
      width: auto;
      padding: var(--sp-1) var(--sp-2);
      gap: 2px;
    }
    .btn-label {
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    /* ========================================
       STICKY TABS (below header)
       ======================================== */

    .tabs-bar {
      position: sticky;
      top: var(--header-height);
      z-index: 99;
      background: var(--bg-base);
      padding: var(--sp-2) var(--sp-4);
      display: flex;
      gap: var(--sp-2);
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
      border-bottom: var(--border-subtle);
    }
    .tabs-bar::-webkit-scrollbar { display: none; }

    .tab {
      display: inline-flex;
      align-items: center;
      gap: var(--sp-2);
      padding: var(--sp-2) var(--sp-4);
      min-height: 36px;
      background: var(--bg-surface);
      border: var(--border-subtle);
      border-radius: var(--radius-full);
      color: var(--text-secondary);
      font-size: var(--text-sm);
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s ease;
    }
    .tab:hover { background: var(--bg-elevated); color: var(--text-primary); }
    .tab.active { background: var(--accent-primary); border-color: var(--accent-primary); color: #fff; }

    .tab .count {
      background: rgba(255,255,255,0.2);
      padding: 2px var(--sp-2);
      border-radius: var(--radius-full);
      font-size: var(--text-xs);
      font-variant-numeric: tabular-nums;
    }

    .tab.pending-tab .count {
      background: var(--accent-warning);
      color: #000;
    }

    /* ========================================
       MAIN LAYOUT: Mobile single column
       Desktop: Two-column 60/40
       ======================================== */

    .main-layout {
      display: flex;
      flex-direction: column;
      min-height: calc(100dvh - var(--header-height) - var(--tabs-height));
    }

    .bookings-panel {
      flex: 1;
      padding: var(--sp-4);
      padding-bottom: calc(var(--sp-12) + 60px); /* Space for drawer handle */
    }

    .context-panel {
      display: none; /* Hidden on mobile - use drawer */
    }

    @media (min-width: 900px) {
      .main-layout {
        flex-direction: row;
        min-height: calc(100dvh - var(--header-height) - var(--tabs-height));
      }

      .bookings-panel {
        flex: 0 0 60%;
        max-width: 60%;
        padding: var(--sp-6);
        padding-bottom: var(--sp-6);
        overflow-y: auto;
        max-height: calc(100dvh - var(--header-height) - var(--tabs-height));
      }

      .context-panel {
        display: block;
        flex: 0 0 40%;
        max-width: 40%;
        background: var(--bg-surface);
        border-left: var(--border-subtle);
        padding: var(--sp-6);
        overflow-y: auto;
        max-height: calc(100dvh - var(--header-height) - var(--tabs-height));
      }

      /* Hide mobile drawer and info button on desktop */
      .drawer { display: none !important; }
      .btn-info { display: none !important; }
    }

    /* ========================================
       BOOKING CARDS - Compact, Action-First
       ======================================== */

    .list { display: block; }
    .list.hidden { display: none; }

    .cards {
      display: flex;
      flex-direction: column;
      gap: var(--sp-3);
    }

    .card {
      background: var(--bg-surface);
      border-radius: var(--radius-lg);
      padding: var(--sp-4);
      border-left: 3px solid var(--border-subtle);
    }
    .card.confirmed { border-left-color: var(--accent-success); }
    .card.cancelled { opacity: 0.5; }

    .card-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: var(--sp-3);
    }

    .card-content { flex: 1; min-width: 0; }

    .card-header {
      display: flex;
      align-items: center;
      gap: var(--sp-2);
      margin-bottom: var(--sp-1);
    }

    .card-name {
      font-size: var(--text-base);
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .source-badge {
      font-size: 9px;
      padding: 2px 5px;
      border-radius: var(--radius-sm);
      font-weight: 500;
      text-transform: uppercase;
      flex-shrink: 0;
      background: var(--bg-elevated);
      color: var(--text-muted);
    }

    .card-info {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--sp-1);
      font-size: var(--text-sm);
      color: var(--text-secondary);
      margin-bottom: var(--sp-2);
    }

    .card-sep { color: var(--text-muted); }

    .card-price {
      color: var(--text-primary);
      font-weight: 600;
    }

    .days-badge {
      background: var(--bg-elevated);
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      font-weight: 500;
      margin-left: auto;
      color: var(--text-secondary);
    }

    .card-meta {
      display: flex;
      gap: var(--sp-2);
      font-size: var(--text-xs);
      color: var(--text-muted);
      align-items: center;
    }

    .guest-badge {
      background: var(--bg-elevated);
      color: var(--text-secondary);
      padding: 2px 8px;
      border-radius: var(--radius-full);
      font-weight: 500;
      font-size: 10px;
    }

    .aging-badge {
      padding: 2px 9px;
      border-radius: var(--radius-full);
      font-weight: 600;
      font-size: 10px;
      letter-spacing: 0.01em;
    }
    .aging-warn {
      background: #451a03;
      color: #fb923c;
      border: 1px solid #7c2d12;
    }
    .aging-critical {
      background: #450a0a;
      color: #f87171;
      border: 1px solid #7f1d1d;
      animation: pulse-red 2s ease-in-out infinite;
    }
    @keyframes pulse-red {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.65; }
    }

    .event-badge {
      padding: 2px 8px;
      border-radius: var(--radius-full);
      font-weight: 500;
      font-size: 10px;
      background: var(--bg-elevated);
      color: var(--text-secondary);
    }

    /* Inline Confirm Button - the star of the show */
    .inline-confirm {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-width: 64px;
      padding: var(--sp-3);
      background: var(--accent-success);
      color: #fff;
      border: none;
      border-radius: var(--radius-md);
      cursor: pointer;
      transition: all 0.15s ease;
      flex-shrink: 0;
    }
    .inline-confirm:hover { background: #059669; transform: scale(1.02); }
    .inline-confirm:active { transform: scale(0.98); }
    .inline-confirm:disabled { background: var(--text-muted); cursor: not-allowed; transform: none; }

    .confirm-icon { width: 18px; height: 18px; flex-shrink: 0; }
    .confirm-text { font-size: 10px; font-weight: 600; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.03em; }

    /* Desktop: Horizontal confirm button */
    @media (min-width: 900px) {
      .inline-confirm {
        flex-direction: row;
        gap: var(--sp-2);
        min-width: auto;
        padding: var(--sp-3) var(--sp-4);
      }
      .confirm-icon { width: 16px; height: 16px; }
      .confirm-text { margin-top: 0; font-size: 13px; }
    }

    .card-contact {
      margin-top: var(--sp-3);
      padding-top: var(--sp-3);
      border-top: var(--border-subtle);
      display: flex;
      flex-wrap: wrap;
      gap: var(--sp-2);
    }
    .card-contact a {
      font-size: var(--text-sm);
      color: var(--accent-info);
      text-decoration: none;
    }
    .card-contact a:hover { text-decoration: underline; }

    .cal-link {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--sp-2);
      margin-top: var(--sp-3);
      padding: var(--sp-3);
      background: rgba(59,130,246,0.1);
      border: 1px solid rgba(59,130,246,0.3);
      border-radius: var(--radius-md);
      color: var(--accent-info);
      font-size: var(--text-sm);
      font-weight: 500;
      text-decoration: none;
      transition: all 0.15s ease;
    }
    .cal-link:hover {
      background: rgba(59,130,246,0.2);
      border-color: var(--accent-info);
    }
    .cal-link:active { transform: scale(0.98); }

    .cal-notice {
      margin-top: var(--sp-3);
      font-size: var(--text-sm);
      color: var(--text-muted);
      text-align: center;
      font-style: italic;
    }

    .cancelled-note {
      margin-top: var(--sp-3);
      font-size: var(--text-sm);
      color: var(--text-muted);
      text-align: center;
    }

    .card-actions {
      display: flex;
      gap: var(--sp-2);
      margin-top: var(--sp-3);
      padding-top: var(--sp-3);
      border-top: var(--border-subtle);
    }

    .btn-secondary, .btn-danger {
      flex: 1;
      min-height: 36px;
      background: transparent;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: var(--radius-md);
      font-size: var(--text-sm);
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      color: var(--text-secondary);
    }
    .btn-secondary:hover { border-color: var(--accent-info); color: var(--accent-info); }
    .btn-danger:hover { border-color: var(--accent-danger); color: var(--accent-danger); }

    /* Filter Bar */
    .filter-bar {
      display: flex;
      gap: var(--sp-2);
      margin-bottom: var(--sp-4);
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
      padding-bottom: var(--sp-1);
    }
    .filter-bar::-webkit-scrollbar { display: none; }

    .filter-btn {
      display: inline-flex;
      align-items: center;
      gap: var(--sp-1);
      padding: var(--sp-2) var(--sp-3);
      background: var(--bg-surface);
      border: var(--border-subtle);
      border-radius: var(--radius-full);
      color: var(--text-secondary);
      font-size: var(--text-xs);
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s ease;
    }
    .filter-btn:hover { background: var(--bg-elevated); color: var(--text-primary); }
    .filter-btn.active { background: var(--accent-success); border-color: var(--accent-success); color: #fff; }
    .filter-btn.time-filter { background: var(--accent-primary); border-color: var(--accent-primary); color: #fff; }
    .filter-btn.time-filter:not(.active) { background: var(--bg-elevated); border-color: var(--accent-primary); color: var(--accent-primary); }
    .filter-btn.past-month { opacity: 0.7; }
    .filter-divider { color: var(--text-muted); padding: 0 var(--sp-1); font-size: var(--text-sm); }
    .filter-count {
      background: rgba(255,255,255,0.2);
      padding: 1px 6px;
      border-radius: var(--radius-full);
      font-size: 10px;
    }

    /* Empty State */
    .empty {
      text-align: center;
      padding: var(--sp-12) var(--sp-4);
      color: var(--text-muted);
    }
    .empty h3 { font-size: var(--text-lg); color: var(--text-secondary); margin-bottom: var(--sp-2); }

    /* ========================================
       BOTTOM DRAWER (Mobile Stats/Info)
       ======================================== */

    .drawer {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: var(--bg-surface);
      border-top: var(--border-subtle);
      border-radius: var(--radius-lg) var(--radius-lg) 0 0;
      z-index: 50;
      transform: translateY(calc(100% - 56px));
      transition: transform 0.3s ease;
      max-height: 70vh;
      overflow: hidden;
    }
    .drawer.open { transform: translateY(0); }

    .drawer-handle {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: var(--sp-4);
      cursor: pointer;
      user-select: none;
    }

    .drawer-handle::before {
      content: '';
      width: 36px;
      height: 4px;
      background: var(--text-muted);
      border-radius: 2px;
    }

    .drawer-handle-text {
      position: absolute;
      font-size: var(--text-sm);
      color: var(--text-secondary);
    }

    .drawer-content {
      padding: 0 var(--sp-4) var(--sp-6);
      overflow-y: auto;
      max-height: calc(70vh - 56px);
    }

    /* Stats Grid */
    .stats {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: var(--sp-3);
      margin-bottom: var(--sp-5);
    }

    .stat {
      background: var(--bg-elevated);
      border-radius: var(--radius-md);
      padding: var(--sp-3);
      text-align: center;
    }

    .stat-val {
      font-size: var(--text-xl);
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      line-height: 1.2;
    }
    .stat-val.pending { color: var(--accent-warning); }
    .stat-val.confirmed { color: var(--accent-success); }
    .stat-val.revenue { color: var(--accent-primary); }

    .stat-lbl {
      font-size: var(--text-xs);
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-top: var(--sp-1);
    }

    /* Info Section */
    .info-section { margin-bottom: var(--sp-4); }
    .info-section h3 {
      font-size: var(--text-sm);
      color: var(--text-secondary);
      margin-bottom: var(--sp-3);
    }

    .info-list {
      font-size: var(--text-sm);
      color: var(--text-muted);
    }
    .info-list li { margin-bottom: var(--sp-2); }
    .info-list strong { color: var(--text-secondary); }

    /* Copy buttons */
    .copy-items { display: flex; flex-direction: column; gap: var(--sp-2); }
    .copy-btn {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--sp-2);
      width: 100%;
      padding: var(--sp-3);
      background: var(--bg-elevated);
      border: var(--border-subtle);
      border-radius: var(--radius-md);
      color: var(--text-secondary);
      font-size: var(--text-sm);
      cursor: pointer;
      transition: all 0.15s ease;
      text-align: left;
    }
    .copy-btn:hover { background: var(--bg-base); color: var(--text-primary); }
    .copy-btn:active { transform: scale(0.98); }
    .copy-btn.copied { background: rgba(16,185,129,0.2); border-color: var(--accent-success); }
    .copy-btn.copied .copy-icon { color: var(--accent-success); }
    .copy-text { flex: 1; }
    .copy-icon { flex-shrink: 0; opacity: 0.5; }
    .copy-btn:hover .copy-icon { opacity: 1; }

    /* ========================================
       CONTEXT PANEL (Desktop Sidebar)
       ======================================== */

    .context-panel h2 {
      font-size: var(--text-lg);
      font-weight: 700;
      margin-bottom: var(--sp-5);
      color: var(--text-primary);
      padding-bottom: var(--sp-3);
      border-bottom: var(--border-subtle);
    }

    .context-panel .stats {
      grid-template-columns: repeat(2, 1fr);
      gap: var(--sp-3);
      margin-bottom: var(--sp-5);
    }

    .context-panel .stat {
      background: var(--bg-base);
      padding: var(--sp-3);
      border-radius: var(--radius-md);
      border: 1px solid rgba(255,255,255,0.05);
    }

    .context-panel .info-section {
      padding-top: var(--sp-4);
      border-top: var(--border-subtle);
    }

    .type-list {
      display: flex;
      flex-direction: column;
      gap: var(--sp-2);
    }
    .type-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .type-count {
      font-weight: 700;
      font-size: var(--text-sm);
      color: var(--text-primary);
    }

    /* Flow Steps */
    .flow { display: flex; flex-direction: column; gap: var(--sp-2); }
    .flow-step { display: flex; gap: var(--sp-2); align-items: flex-start; }
    .flow-num {
      width: 20px; height: 20px;
      background: var(--accent-primary);
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px;
      font-weight: 700;
      flex-shrink: 0;
    }
    .flow-text h4 { font-size: var(--text-xs); font-weight: 600; margin-bottom: 1px; }
    .flow-text p { font-size: 10px; color: var(--text-muted); line-height: 1.3; }

    /* ========================================
       TOAST
       ======================================== */

    .toast {
      position: fixed;
      bottom: calc(env(safe-area-inset-bottom) + 70px);
      left: 50%;
      transform: translateX(-50%) translateY(100px);
      background: var(--accent-success);
      color: #fff;
      padding: var(--sp-3) var(--sp-5);
      border-radius: var(--radius-full);
      font-size: var(--text-sm);
      font-weight: 500;
      box-shadow: var(--shadow-lg);
      opacity: 0;
      transition: all 0.3s ease;
      z-index: 1001;
    }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

    @media (min-width: 900px) {
      .toast { bottom: var(--sp-6); }
    }

    /* ========================================
       MODAL
       ======================================== */

    .modal-overlay {
      position: fixed;
      inset: 0;
      background: var(--bg-overlay);
      display: flex;
      align-items: flex-end;
      justify-content: center;
      z-index: 1000;
      padding: var(--sp-4);
    }
    @media (min-width: 600px) { .modal-overlay { align-items: center; } }

    .modal {
      background: var(--bg-surface);
      border-radius: var(--radius-lg) var(--radius-lg) 0 0;
      padding: var(--sp-6);
      width: 100%;
      max-width: 420px;
      max-height: 85vh;
      overflow-y: auto;
    }
    @media (min-width: 600px) { .modal { border-radius: var(--radius-lg); } }

    .modal h2 { font-size: var(--text-lg); margin-bottom: var(--sp-4); }

    .modal-info {
      background: var(--bg-elevated);
      padding: var(--sp-4);
      border-radius: var(--radius-md);
      margin-bottom: var(--sp-4);
    }
    .modal-info p { font-size: var(--text-sm); color: var(--text-secondary); margin-bottom: var(--sp-2); }
    .modal-info p:last-child { margin-bottom: 0; }

    .policy-box {
      background: var(--bg-elevated);
      border-left: 3px solid var(--accent-warning);
      padding: var(--sp-4);
      margin-bottom: var(--sp-4);
      border-radius: 0 var(--radius-md) var(--radius-md) 0;
    }
    .policy-box.refund { border-left-color: var(--accent-success); }
    .policy-box.no-refund { border-left-color: var(--accent-danger); }
    .policy-box p { font-size: var(--text-sm); color: var(--text-secondary); }

    .form-group { margin-bottom: var(--sp-4); }
    .form-group label { display: block; font-size: var(--text-sm); color: var(--text-muted); margin-bottom: var(--sp-2); }
    .form-group input, .form-group select {
      width: 100%;
      min-height: var(--touch-min);
      padding: 0 var(--sp-4);
      background: var(--bg-elevated);
      border: var(--border-subtle);
      border-radius: var(--radius-md);
      color: var(--text-primary);
      font-size: var(--text-base);
    }

    .modal-actions { display: flex; gap: var(--sp-3); margin-top: var(--sp-5); }
    .modal-btn {
      flex: 1;
      min-height: var(--touch-min);
      border: none;
      border-radius: var(--radius-md);
      font-size: var(--text-sm);
      font-weight: 500;
      cursor: pointer;
    }
    .modal-btn.secondary { background: var(--bg-elevated); color: var(--text-primary); }
    .modal-btn.danger { background: var(--accent-danger); color: #fff; }
    .modal-btn.primary { background: var(--accent-info); color: #fff; }

    /* ========================================
       CALENDAR-FIRST LAYOUT OVERRIDES
       ======================================== */

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--sp-4);
      background: var(--bg-base);
      border-bottom: var(--border-subtle);
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .btn-refresh {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      font-size: 1.25rem;
      cursor: pointer;
      padding: var(--sp-2);
    }
    .btn-refresh:hover { color: var(--text-primary); }

    .container {
      max-width: 800px;
      margin: 0 auto;
      padding: var(--sp-4);
    }

    /* Call-out Cards */
    .callout-cards {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--sp-3);
      margin-bottom: var(--sp-5);
    }

    @media (max-width: 600px) {
      .callout-cards {
        grid-template-columns: 1fr;
      }
    }

    .callout-card {
      background: var(--bg-surface);
      border: var(--border-subtle);
      border-radius: var(--radius-md);
      padding: var(--sp-4);
      text-align: center;
    }

    .callout-card.accent {
      background: rgba(16,185,129,0.1);
      border-color: rgba(16,185,129,0.3);
    }

    .callout-card.attention {
      background: rgba(245,158,11,0.1);
      border-color: rgba(245,158,11,0.3);
    }
    .callout-card.attention .callout-value {
      color: var(--accent-warning);
    }

    .callout-card.ready {
      background: rgba(59,130,246,0.1);
      border-color: rgba(59,130,246,0.3);
    }
    .callout-card.ready .callout-value {
      color: #3b82f6;
    }

    .callout-card.balance-due {
      background: rgba(168,85,247,0.1);
      border-color: rgba(168,85,247,0.3);
    }
    .callout-card.balance-due .callout-value {
      color: #a855f7;
    }

    .callout-value {
      font-size: 2rem;
      font-weight: 700;
      color: var(--text-primary);
      line-height: 1.2;
      font-variant-numeric: tabular-nums;
    }

    .callout-card.accent .callout-value {
      color: var(--accent-success);
    }

    .callout-label {
      font-size: var(--text-sm);
      color: var(--text-secondary);
      margin-top: var(--sp-1);
    }

    .callout-detail {
      font-size: var(--text-xs);
      color: var(--text-muted);
      margin-top: var(--sp-1);
    }

    /* Needs Action Section */
    .needs-action {
      background: rgba(245,158,11,0.1);
      border: 1px solid rgba(245,158,11,0.3);
      border-radius: var(--radius-md);
      padding: var(--sp-4);
      margin-bottom: var(--sp-5);
    }

    .section-title {
      display: flex;
      align-items: center;
      gap: var(--sp-2);
      font-size: var(--text-base);
      font-weight: 700;
      margin-bottom: var(--sp-3);
      color: var(--text-primary);
    }

    .pulse {
      width: 8px;
      height: 8px;
      background: var(--accent-warning);
      border-radius: 50%;
      animation: pulse-dot 2s infinite;
    }

    @keyframes pulse-dot {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(1.2); }
    }

    .section-count {
      background: var(--bg-elevated);
      padding: 2px 8px;
      border-radius: var(--radius-full);
      font-size: var(--text-xs);
      color: var(--text-muted);
    }

    .action-list {
      display: flex;
      flex-direction: column;
      gap: var(--sp-3);
    }

    .action-item {
      display: flex;
      align-items: stretch;
      gap: var(--sp-3);
      background: var(--bg-surface);
      padding: var(--sp-3);
      border-radius: var(--radius-md);
      border-left: 3px solid var(--border-subtle);
    }

    .action-urgency {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--sp-1);
      min-width: 70px;
    }

    .urgency-badge {
      font-size: var(--text-xs);
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      background: var(--bg-elevated);
      color: var(--text-secondary);
    }

    .pending-age {
      font-size: 10px;
      color: var(--text-muted);
    }

    .action-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: var(--sp-1);
    }

    .action-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .action-name {
      font-weight: 700;
      font-size: var(--text-base);
      color: var(--text-primary);
    }

    .action-price {
      font-size: var(--text-lg);
      font-weight: 600;
      color: var(--text-primary);
    }

    .action-meta {
      display: flex;
      align-items: center;
      gap: var(--sp-2);
      flex-wrap: wrap;
    }

    .action-date {
      font-size: var(--text-xs);
      color: var(--text-secondary);
    }

    .payment-status {
      font-size: var(--text-xs);
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      background: var(--bg-elevated);
      color: var(--text-muted);
    }

    .action-buttons {
      display: flex;
      align-items: center;
      gap: var(--sp-2);
    }

    .btn-action {
      background: transparent;
      border: 1px solid var(--border-subtle);
      padding: var(--sp-2) var(--sp-3);
      border-radius: var(--radius-sm);
      font-size: var(--text-xs);
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      color: var(--text-secondary);
      transition: all 0.15s ease;
    }
    .btn-action:hover { border-color: var(--text-muted); color: var(--text-primary); }
    .btn-cancel:hover { border-color: var(--accent-danger); color: var(--accent-danger); }

    .btn-confirm {
      background: var(--accent-success);
      color: var(--btn-confirm-text);
      border: none;
      padding: var(--sp-2) var(--sp-4);
      border-radius: var(--radius-sm);
      font-weight: 600;
      font-size: var(--text-sm);
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s ease;
    }
    .btn-confirm:hover { opacity: 0.85; }

    .btn-deposit {
      background: transparent;
      color: #22c55e;
      border: 1px solid #22c55e;
      padding: var(--sp-2) var(--sp-3);
      border-radius: var(--radius-sm);
      font-weight: 500;
      font-size: var(--text-xs);
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s ease;
    }
    .btn-deposit:hover {
      background: rgba(34, 197, 94, 0.1);
    }

    .btn-balance {
      background: transparent;
      color: var(--accent-info);
      border: 1px solid var(--accent-info);
      padding: var(--sp-2) var(--sp-3);
      border-radius: var(--radius-sm);
      font-weight: 500;
      font-size: var(--text-xs);
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s ease;
    }
    .btn-balance:hover {
      background: rgba(59, 130, 246, 0.1);
    }

    /* Payment Status Badges */
    .balance-owed {
      color: var(--accent-warning);
      font-size: var(--text-xs);
    }
    .payment-status.fully-paid {
      color: #22c55e;
    }
    .payment-status.balance-due {
      color: var(--accent-warning);
    }

    /* Confirmed Section */
    .confirmed-section {
      margin-bottom: var(--sp-5);
    }
    .confirmed-section .action-item.confirmed {
      opacity: 0.9;
    }
    .confirmed-section .action-item.past {
      opacity: 0.5;
    }
    .confirmed-icon {
      color: #22c55e;
      margin-right: var(--sp-1);
    }
    .urgency-badge.confirmed {
      background: rgba(34, 197, 94, 0.15);
      color: #22c55e;
    }
    .urgency-badge.past {
      background: rgba(239, 68, 68, 0.15);
      color: #ef4444;
    }

    /* Deposit Paid Section */
    .deposit-paid .checkmark {
      color: #22c55e;
      margin-right: var(--sp-1);
    }

    .show-more {
      text-align: center;
      color: var(--text-muted);
      font-size: var(--text-sm);
      padding: var(--sp-3);
    }

    /* Balance Due Section */
    .balance-due-section {
      background: rgba(168,85,247,0.05);
      border: 1px solid rgba(168,85,247,0.2);
      border-radius: var(--radius-md);
      padding: var(--sp-4);
      margin-bottom: var(--sp-5);
    }
    .balance-icon {
      color: #a855f7;
      font-weight: 700;
      margin-right: var(--sp-1);
    }

    /* Day Sections */
    .week-view {
      margin-bottom: var(--sp-5);
    }

    .day-section {
      background: var(--bg-surface);
      border-radius: var(--radius-md);
      margin-bottom: var(--sp-3);
      overflow: hidden;
    }

    .day-section.today {
      border: 1px solid var(--accent-primary);
    }

    .day-section.empty-day {
      opacity: 0.6;
    }

    .day-header {
      display: flex;
      align-items: center;
      gap: var(--sp-2);
      padding: var(--sp-3) var(--sp-4);
      background: var(--bg-elevated);
      border-bottom: var(--border-subtle);
    }

    .day-label {
      font-weight: 700;
      font-size: var(--text-sm);
      color: var(--text-primary);
    }

    .day-section.today .day-label {
      color: var(--accent-primary);
    }

    .day-date {
      font-size: var(--text-xs);
      color: var(--text-muted);
    }

    .day-count {
      background: var(--accent-primary);
      color: #fff;
      margin-left: var(--sp-2);
      padding: 2px 8px;
      border-radius: var(--radius-full);
      font-size: 10px;
      font-weight: 700;
    }

    .day-events {
      padding: var(--sp-2);
    }

    .no-events {
      padding: var(--sp-3);
      text-align: center;
      color: var(--text-muted);
      font-size: var(--text-sm);
    }

    /* Event Row */
    .event-row {
      display: flex;
      align-items: center;
      gap: var(--sp-3);
      padding: var(--sp-3);
      border-radius: var(--radius-sm);
      border-left: 3px solid var(--accent-success);
    }

    .event-row.pending {
      border-left-color: var(--accent-warning);
      background: rgba(245,158,11,0.05);
    }

    .event-row.duplicate {
      border-left-color: var(--accent-danger);
      background: rgba(239,68,68,0.08);
    }

    .event-row.synced {
      opacity: 0.6;  /* Dim synced duplicates - they're expected */
    }

    .dup-badge {
      font-size: 14px;
      margin-right: var(--sp-1);
    }

    .sync-badge {
      font-size: 12px;
      margin-right: var(--sp-1);
      opacity: 0.5;
    }

    .cal-badge {
      font-size: 14px;
      opacity: 0.6;
    }

    .btn-cal-link {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      background: var(--bg-elevated);
      border-radius: var(--radius-sm);
      font-size: 14px;
      text-decoration: none;
      transition: all 0.15s ease;
    }
    .btn-cal-link:hover {
      background: var(--accent-info);
      transform: scale(1.05);
    }

    .event-time {
      min-width: 50px;
      font-size: var(--text-sm);
      font-weight: 600;
      color: var(--text-secondary);
    }

    .event-details {
      flex: 1;
      display: flex;
      align-items: center;
      gap: var(--sp-2);
      flex-wrap: wrap;
    }

    .event-name {
      font-weight: 600;
      color: var(--text-primary);
    }

    .event-price {
      color: var(--accent-success);
      font-weight: 600;
      font-size: var(--text-sm);
    }

    .event-actions {
      display: flex;
      gap: var(--sp-2);
    }

    .btn-confirm-small, .btn-cal-small, .btn-more {
      background: var(--bg-elevated);
      border: none;
      width: 32px;
      height: 32px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 14px;
    }

    .btn-confirm-small {
      background: var(--accent-success);
      color: var(--btn-confirm-text);
    }

    /* Row action buttons (calendar view) */
    .btn-row-action {
      background: var(--bg-elevated);
      border: 1px solid var(--accent-primary);
      width: 36px;
      height: 36px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
      text-decoration: none;
      color: var(--text-primary);
    }
    .btn-row-action:hover {
      background: var(--accent-primary);
    }
    .btn-row-danger:hover {
      background: rgba(239, 68, 68, 0.2);
      border-color: var(--accent-danger);
    }

    .event-status {
      font-size: 12px;
      margin-right: var(--sp-1);
      color: var(--text-muted);
    }
    .event-status.confirmed {
      color: #22c55e;
    }

    .cal-only-badge {
      font-size: var(--text-xs);
      color: var(--text-muted);
      padding: 2px 6px;
      background: var(--bg-elevated);
      border-radius: var(--radius-sm);
    }

    .cal-only-link {
      font-size: var(--text-xs);
      color: var(--text-secondary);
      padding: 2px 8px;
      background: var(--bg-elevated);
      border-radius: var(--radius-sm);
      text-decoration: none;
      transition: all 0.15s ease;
    }
    .cal-only-link:hover {
      background: var(--accent-primary);
      color: var(--text-primary);
    }

    /* Later Section */
    .later-section {
      background: var(--bg-surface);
      border-radius: var(--radius-md);
      padding: var(--sp-4);
    }

    .later-list {
      display: flex;
      flex-direction: column;
      gap: var(--sp-2);
    }

    .later-item {
      display: flex;
      align-items: center;
      gap: var(--sp-3);
      padding: var(--sp-2);
      border-bottom: var(--border-subtle);
    }

    .later-item:last-child {
      border-bottom: none;
    }

    .later-status {
      font-size: 12px;
      width: 20px;
      color: var(--text-muted);
    }
    .later-status.confirmed {
      color: #22c55e;
    }

    .later-date {
      min-width: 100px;
      font-size: var(--text-sm);
      color: var(--text-secondary);
    }

    .later-actions {
      margin-left: auto;
      display: flex;
      gap: var(--sp-1);
    }

    .later-name {
      flex: 1;
      font-weight: 500;
      color: var(--text-primary);
    }
  </style>
</head>
<body>
  <!-- SIMPLE HEADER -->
  <header class="header">
    <span style="font-weight: 600; font-size: 1rem; color: var(--text-primary);">Hibiscus Studio</span>
    <div style="display: flex; gap: 8px; align-items: center;">
      <button class="btn-theme" onclick="toggleTheme()" title="Toggle light/dark mode">
        <span class="theme-icon-dark">☀</span>
        <span class="theme-icon-light">☾</span>
      </button>
      <button class="btn-refresh" onclick="location.reload()">↻</button>
      <a href="/cdn-cgi/access/logout" style="padding: 6px 12px; background: var(--bg-elevated); border-radius: 6px; color: var(--text-secondary); text-decoration: none; font-size: 12px;">Logout</a>
    </div>
  </header>

  <main class="container">
    <!-- CALL-OUT CARDS -->
    <section class="callout-cards">
      <div class="callout-card ${awaitingDepositBookings.length > 0 ? 'attention' : ''}">
        <div class="callout-value">${awaitingDepositBookings.length}</div>
        <div class="callout-label">Awaiting Deposit</div>
        <div class="callout-detail">need payment</div>
      </div>
      <div class="callout-card ${depositPaidBookings.length > 0 ? 'ready' : ''}">
        <div class="callout-value">${depositPaidBookings.length}</div>
        <div class="callout-label">Deposit Paid</div>
        <div class="callout-detail">ready to confirm</div>
      </div>
      <div class="callout-card">
        <div class="callout-value">${thisWeekBookings.length}</div>
        <div class="callout-label">This Week</div>
        <div class="callout-detail">${weekConfirmed.length} confirmed</div>
      </div>
      ${balanceDueBookings.length > 0 ? `
      <div class="callout-card balance-due">
        <div class="callout-value">${balanceDueBookings.length}</div>
        <div class="callout-label">Balance Due</div>
        <div class="callout-detail">awaiting payment</div>
      </div>
      ` : ''}
    </section>

    <!-- AWAITING DEPOSIT - Bookings where deposit has not been marked as paid -->
    ${awaitingDepositBookings.length > 0 ? `
    <section class="needs-action awaiting-deposit">
      <h2 class="section-title">
        <span class="pulse"></span>
        Awaiting Deposit
        <span class="section-count">${awaitingDepositBookings.length}</span>
      </h2>
      <div class="action-list">
        ${awaitingDepositBookings.map(b => {
          const eventDate = new Date(b.date);
          const daysUntil = Math.ceil((eventDate - today) / (1000 * 60 * 60 * 24));
          const urgencyClass = daysUntil < 0 ? 'past' : daysUntil <= 2 ? 'urgent' : daysUntil <= 7 ? 'soon' : '';
          const urgencyLabel = daysUntil < 0 ? 'PAST' : daysUntil === 0 ? 'TODAY' : daysUntil === 1 ? 'TOMORROW' : daysUntil + 'd away';

          return `
          <div class="action-item ${urgencyClass}" data-id="${b.id}">
            <div class="action-urgency">
              <span class="urgency-badge ${urgencyClass}">${urgencyLabel}</span>
            </div>
            <div class="action-main">
              <div class="action-header">
                <span class="action-name">${b.name || 'New Booking'}</span>
                <span class="action-price">${b.total ? '£' + b.total : ''}</span>
              </div>
              <div class="action-meta">
                <span class="action-date">${formatDate(b.date)}</span>
                <span class="event-badge ${getEventTypeClass(b.eventType)}">${b.eventType || 'Event'}</span>
              </div>
            </div>
            <div class="action-buttons">
              <button class="btn-action btn-change" onclick="showChangeDateModal('${b.id}', '${b.date}', ${daysUntil}, ${b.dateChangeCount || 0}, ${b.duration || 6})">Change</button>
              <button class="btn-action btn-cancel" onclick="showCancelModal('${b.id}', '${b.name}', '${b.date}', ${daysUntil}, ${b.deposit || 150}, ${b.total || 300})">Cancel</button>
              <button class="btn-deposit" onclick="markDepositPaid('${b.id}')">Deposit Received</button>
            </div>
          </div>
          `;
        }).join('')}
      </div>
    </section>
    ` : ''}

    <!-- DEPOSIT PAID - Bookings where deposit paid but not yet confirmed -->
    ${depositPaidBookings.length > 0 ? `
    <section class="needs-action deposit-paid">
      <h2 class="section-title">
        <span class="checkmark">✓</span>
        Deposit Paid
        <span class="section-count">${depositPaidBookings.length}</span>
      </h2>
      <div class="action-list">
        ${depositPaidBookings.map(b => {
          const eventDate = new Date(b.date);
          const daysUntil = Math.ceil((eventDate - today) / (1000 * 60 * 60 * 24));
          const urgencyClass = daysUntil < 0 ? 'past' : daysUntil <= 2 ? 'urgent' : daysUntil <= 7 ? 'soon' : '';
          const urgencyLabel = daysUntil < 0 ? 'PAST' : daysUntil === 0 ? 'TODAY' : daysUntil === 1 ? 'TOMORROW' : daysUntil + 'd away';

          return `
          <div class="action-item ${urgencyClass}" data-id="${b.id}">
            <div class="action-urgency">
              <span class="urgency-badge ${urgencyClass}">${urgencyLabel}</span>
            </div>
            <div class="action-main">
              <div class="action-header">
                <span class="action-name">${b.name || 'Booking'}</span>
                <span class="action-price">${b.total ? '£' + b.total : ''}</span>
              </div>
              <div class="action-meta">
                <span class="action-date">${formatDate(b.date)}</span>
                <span class="event-badge ${getEventTypeClass(b.eventType)}">${b.eventType || 'Event'}</span>
              </div>
            </div>
            <div class="action-buttons">
              <button class="btn-action btn-change" onclick="showChangeDateModal('${b.id}', '${b.date}', ${daysUntil}, ${b.dateChangeCount || 0}, ${b.duration || 6})">Change</button>
              <button class="btn-action btn-cancel" onclick="showCancelModal('${b.id}', '${b.name}', '${b.date}', ${daysUntil}, ${b.deposit || 150}, ${b.total || 300})">Cancel</button>
              <button class="btn-confirm" onclick="confirmBooking('${b.id}')">✓ Confirm</button>
            </div>
          </div>
          `;
        }).join('')}
      </div>
    </section>
    ` : ''}

    <!-- BALANCE DUE - Confirmed bookings awaiting full payment -->
    ${balanceDueBookings.length > 0 ? `
    <section class="needs-action balance-due-section">
      <h2 class="section-title">
        <span class="balance-icon">£</span>
        Balance Due
        <span class="section-count">${balanceDueBookings.length}</span>
      </h2>
      <div class="action-list">
        ${balanceDueBookings.map(b => {
          const eventDate = new Date(b.date);
          const daysUntil = Math.ceil((eventDate - today) / (1000 * 60 * 60 * 24));
          const urgencyClass = daysUntil < 0 ? 'past' : daysUntil <= 7 ? 'soon' : '';
          const urgencyLabel = daysUntil < 0 ? 'PAST' : daysUntil === 0 ? 'TODAY' : daysUntil === 1 ? 'TOMORROW' : daysUntil + 'd away';
          const balanceOwed = (b.total || 0) - (b.deposit || 0);

          return `
          <div class="action-item ${urgencyClass}" data-id="${b.id}">
            <div class="action-urgency">
              <span class="urgency-badge ${urgencyClass}">${urgencyLabel}</span>
            </div>
            <div class="action-main">
              <div class="action-header">
                <span class="action-name">${b.name || 'Booking'}</span>
                <span class="action-price">£${balanceOwed} due</span>
              </div>
              <div class="action-meta">
                <span class="action-date">${formatDate(b.date)}</span>
                <span class="event-badge ${getEventTypeClass(b.eventType)}">${b.eventType || 'Event'}</span>
              </div>
            </div>
            <div class="action-buttons">
              <button class="btn-action btn-change" onclick="showChangeDateModal('${b.id}', '${b.date}', ${daysUntil}, ${b.dateChangeCount || 0}, ${b.duration || 6})">Change</button>
              <button class="btn-action btn-cancel" onclick="showCancelModal('${b.id}', '${b.name}', '${b.date}', ${daysUntil}, ${b.deposit || 150}, ${b.total || 300})">Cancel</button>
              <button class="btn-balance" onclick="markBalancePaid('${b.id}')">Balance Received</button>
            </div>
          </div>
          `;
        }).join('')}
      </div>
    </section>
    ` : ''}

    <!-- THIS WEEK -->
    <section class="week-view">
      <h2 class="section-title">This Week</h2>
      ${dayBuckets.map(generateDaySection).join('')}
    </section>

    <!-- COMING UP (beyond 7 days) -->
    ${laterBookings.length > 0 ? `
    <section class="later-section">
      <h2 class="section-title">Coming Up <span class="section-count">${laterBookings.length}</span></h2>
      <div class="later-list">
        ${laterBookings.map(b => {
          const eventDate = new Date(b.date);
          const daysUntil = Math.ceil((eventDate - today) / (1000 * 60 * 60 * 24));
          const isCalendarOnly = b.fromCalendar && !b.fromKV;
          const statusIcon = b.status === 'confirmed' ? '✓' : (b.depositPaid ? '○' : '◌');
          const gcalLink = getDirectCalendarUrl(b.calendarEventId, b.calendarEmail, b.date) || getCalendarDayUrl(b.date);

          return `
          <div class="later-item" data-id="${b.id}">
            <span class="later-status ${b.status === 'confirmed' ? 'confirmed' : ''}" title="${b.status}">${statusIcon}</span>
            <span class="later-date">${formatDate(b.date)}</span>
            <span class="later-name">${cleanName(b.name)}</span>
            <span class="event-badge ${getEventTypeClass(b.eventType)}">${b.eventType || 'Event'}</span>
            <div class="later-actions">
              ${!isCalendarOnly ? `
              <button class="btn-row-action" onclick="showChangeDateModal('${b.id}', '${b.date}', ${daysUntil}, ${b.dateChangeCount || 0}, ${b.duration || 6})" title="Reschedule">↻</button>
              <button class="btn-row-action btn-row-danger" onclick="showCancelModal('${b.id}', '${b.name}', '${b.date}', ${daysUntil}, ${b.deposit || 150}, ${b.total || 300})" title="Cancel">✕</button>
              <a href="${gcalLink}" target="_blank" class="btn-row-action" title="View in Calendar">▸</a>
              ` : `
              <a href="${gcalLink}" target="_blank" class="cal-only-link" title="View in Google Calendar">Cal only ▸</a>
              `}
            </div>
          </div>
          `;
        }).join('')}
      </div>
    </section>
    ` : ''}
  </main>

  <div id="toast" class="toast"></div>

  <script>
    // Theme Toggle
    (function() {
      const savedTheme = localStorage.getItem('hb-theme') || 'dark';
      document.documentElement.setAttribute('data-theme', savedTheme);
    })();

    function toggleTheme() {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('hb-theme', next);
    }

    // Copy to clipboard
    async function copyToClipboard(text, btn) {
      try {
        await navigator.clipboard.writeText(text);
        btn.classList.add('copied');
        showToast('Copied: ' + text);
        setTimeout(() => btn.classList.remove('copied'), 2000);
      } catch (e) {
        // Fallback for older browsers
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        btn.classList.add('copied');
        showToast('Copied: ' + text);
        setTimeout(() => btn.classList.remove('copied'), 2000);
      }
    }

    async function confirmBooking(id) {
      const btn = document.querySelector('[data-id="'+id+'"] .btn-confirm');
      btn.disabled = true;
      btn.textContent = 'Confirming...';

      try {
        const res = await fetch('/api/bookings/'+id+'/confirm', {
          method: 'POST',
          credentials: 'include'
        });

        if (res.ok) {
          btn.textContent = 'Confirmed!';
          showToast('Booking confirmed');
          setTimeout(() => location.reload(), 1500);
        } else {
          throw new Error('Failed');
        }
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Confirm Payment';
        showToast('Error - try again');
      }
    }

    async function markDepositPaid(id) {
      const btn = document.querySelector('[data-id="'+id+'"] .btn-deposit');
      if (!btn) return;
      btn.disabled = true;
      btn.textContent = 'Marking...';

      try {
        const res = await fetch('/api/bookings/'+id+'/mark-deposit-paid', {
          method: 'POST',
          credentials: 'include'
        });

        if (res.ok) {
          btn.textContent = 'Done!';
          showToast('Deposit marked as paid');
          setTimeout(() => location.reload(), 1500);
        } else {
          const data = await res.json();
          throw new Error(data.error || 'Failed');
        }
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Deposit Received';
        showToast('Error: ' + e.message);
      }
    }

    async function markBalancePaid(id) {
      const btn = document.querySelector('[data-id="'+id+'"] .btn-balance');
      if (!btn) return;
      btn.disabled = true;
      btn.textContent = 'Marking...';

      try {
        const res = await fetch('/api/bookings/'+id+'/mark-balance-paid', {
          method: 'POST',
          credentials: 'include'
        });

        if (res.ok) {
          btn.textContent = 'Done!';
          showToast('Balance marked as paid');
          setTimeout(() => location.reload(), 1500);
        } else {
          const data = await res.json();
          throw new Error(data.error || 'Failed');
        }
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Balance Received';
        showToast('Error: ' + e.message);
      }
    }

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 3000);
    }

    function showCancelModal(id, name, date, days, deposit, total) {
      const isRefund = days >= 7;
      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.id = 'cancelModal';
      modal.innerHTML = \`
        <div class="modal">
          <h2>Cancel Booking</h2>
          <div class="modal-info">
            <p><strong>\${name}</strong></p>
            <p>\${formatDateJS(date)}</p>
          </div>
          <div class="policy-box \${isRefund ? 'refund' : 'no-refund'}">
            <p><strong>\${days} days notice</strong></p>
            <p>\${isRefund
              ? 'Deposit (£'+deposit+') forfeit. Balance refunded if paid.'
              : 'No refund available (<7 days notice).'}</p>
          </div>
          <div class="modal-actions">
            <button class="modal-btn secondary" onclick="closeModal('cancelModal')">Keep</button>
            <button class="modal-btn danger" onclick="cancelBooking('\${id}')">Cancel</button>
          </div>
        </div>
      \`;
      document.body.appendChild(modal);
    }

    async function cancelBooking(id) {
      const btn = document.querySelector('#cancelModal .danger');
      btn.textContent = 'Cancelling...';
      btn.disabled = true;

      try {
        const res = await fetch('/api/bookings/'+id+'/cancel', {
          method: 'POST',
          credentials: 'include'
        });

        if (res.ok) {
          closeModal('cancelModal');
          showToast('Booking cancelled');
          setTimeout(() => location.reload(), 1500);
        } else {
          throw new Error('Failed');
        }
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Cancel';
        showToast('Error - try again');
      }
    }

    var _changeDuration = 6;

    function showChangeDateModal(id, date, days, changes, duration) {
      if (changes >= 1) {
        alert('Already changed once. Second change = cancellation.');
        return;
      }

      _changeDuration = duration || 6;
      const fee = days >= 7 ? 'Free' : '£50 fee';
      const durationLabel = _changeDuration + 'h booking';
      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.id = 'changeDateModal';
      modal.innerHTML = \`
        <div class="modal">
          <h2>Change Date</h2>
          <div class="policy-box">
            <p><strong>\${fee}</strong> (\${days} days notice)</p>
            <p style="font-size:12px;color:var(--text-muted);margin-top:4px;">\${durationLabel} — slots match original duration</p>
          </div>
          <div class="form-group">
            <label>New Date</label>
            <input type="date" id="newDate" min="\${getTomorrow()}" onchange="fetchSlots(this.value)">
          </div>
          <div class="form-group">
            <label>Time Slot</label>
            <select id="newSlot" disabled>
              <option value="">Select a date first</option>
            </select>
            <div id="slotStatus" style="font-size:12px;color:var(--text-muted);margin-top:4px;"></div>
          </div>
          <div class="modal-actions">
            <button class="modal-btn secondary" onclick="closeModal('changeDateModal')">Cancel</button>
            <button class="modal-btn primary" id="changeBtn" onclick="changeDate('\${id}')" disabled>Change</button>
          </div>
        </div>
      \`;
      document.body.appendChild(modal);
    }

    async function fetchSlots(date) {
      const select = document.getElementById('newSlot');
      const status = document.getElementById('slotStatus');
      const btn = document.getElementById('changeBtn');

      select.innerHTML = '<option value="">Loading...</option>';
      select.disabled = true;
      btn.disabled = true;
      status.textContent = '';

      try {
        const res = await fetch('/api/availability?date=' + date + '&duration=' + _changeDuration);
        const data = await res.json();
        const available = data.slots.filter(s => s.available);

        if (available.length === 0) {
          select.innerHTML = '<option value="">No slots available</option>';
          status.textContent = 'All slots booked on this date. Try another day.';
          status.style.color = 'var(--accent-danger)';
        } else {
          select.innerHTML = available.map(s =>
            \`<option value="\${s.id}">\${s.label}\${s.surcharge ? ' (+£'+s.surcharge+')' : ''}</option>\`
          ).join('');
          select.disabled = false;
          btn.disabled = false;
          status.textContent = available.length + ' of 4 slots available';
          status.style.color = 'var(--accent-success)';
        }
      } catch (e) {
        select.innerHTML = '<option value="">Error loading</option>';
        status.textContent = 'Could not check availability';
        status.style.color = 'var(--accent-danger)';
      }
    }

    async function changeDate(id) {
      const newDate = document.getElementById('newDate').value;
      const newSlot = document.getElementById('newSlot').value;

      if (!newDate || !newSlot) return;

      const btn = document.getElementById('changeBtn');
      btn.textContent = 'Changing...';
      btn.disabled = true;

      try {
        const res = await fetch('/api/bookings/'+id+'/change-date', {
          method: 'POST',
          credentials: 'include',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({newDate, newTimeSlot: newSlot})
        });

        const data = await res.json();

        if (res.ok) {
          closeModal('changeDateModal');
          showToast('Date changed to ' + newDate);
          setTimeout(() => location.reload(), 1500);
        } else {
          throw new Error(data.message || data.error || 'Failed');
        }
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Change';
        showToast('Error: ' + e.message);
      }
    }

    function closeModal(id) {
      const m = document.getElementById(id);
      if (m) m.remove();
    }

    function formatDateJS(d) {
      return new Date(d).toLocaleDateString('en-GB', {weekday:'short', day:'numeric', month:'short'});
    }

    function getTomorrow() {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      return d.toISOString().split('T')[0];
    }
  </script>
</body>
</html>
  `;
}

// ============================================
// Admin Dashboard V2 — 5-Tab Layout
// ============================================

function generateAdminDashboardV2(bookings, options = {}) {
  // === DATA COMPUTATION (copied from v1) ===
  const now = getLondonNow();
  const currentYear = now.getFullYear();

  const kvBookings = bookings.filter(b => b.fromKV);
  const calendarOnlyBookings = bookings.filter(b => b.fromCalendar && !b.fromKV);

  const today = getLondonToday();
  const upcomingBookings = bookings.filter(b => {
    const eventDate = new Date(b.date);
    return eventDate >= today && b.status !== 'cancelled';
  });

  const confirmedWithPrice = bookings.filter(b =>
    b.status === 'confirmed' && b.total && b.total > 0
  );
  const ytdConfirmedWithPrice = confirmedWithPrice.filter(b => {
    const eventDate = new Date(b.date);
    return eventDate.getFullYear() === currentYear;
  });

  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenDaysFromNow = new Date(today);
  sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

  const pastWeekEvents = bookings.filter(b => {
    const d = new Date(b.date);
    return d >= sevenDaysAgo && d < today && b.status !== 'cancelled';
  });

  const nextWeekEvents = bookings.filter(b => {
    const d = new Date(b.date);
    return d >= today && d <= sevenDaysFromNow && b.status !== 'cancelled';
  });

  const nextWeekByType = {};
  nextWeekEvents.forEach(b => {
    const type = b.eventType || 'Other';
    nextWeekByType[type] = (nextWeekByType[type] || 0) + 1;
  });

  const stats = {
    total: bookings.length,
    pending: bookings.filter(b => b.status === 'pending').length,
    confirmed: bookings.filter(b => b.status === 'confirmed').length,
    cancelled: bookings.filter(b => b.status === 'cancelled').length,
    fromKV: kvBookings.length,
    fromCalendar: calendarOnlyBookings.length,
    upcoming: upcomingBookings.length,
    upcomingConfirmed: upcomingBookings.filter(b => b.status === 'confirmed').length,
    pastWeek: pastWeekEvents.length,
    nextWeek: nextWeekEvents.length,
    nextWeekByType: nextWeekByType,
    ytdBookings: bookings.filter(b => {
      const eventDate = new Date(b.date);
      return eventDate.getFullYear() === currentYear && b.status !== 'cancelled';
    }).length,
    ytdRevenue: ytdConfirmedWithPrice.reduce((sum, b) => sum + b.total, 0),
    ytdRevenueCount: ytdConfirmedWithPrice.length,
    monthlyBreakdown: {},
  };

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  months.forEach((m, i) => { stats.monthlyBreakdown[m] = 0; });
  bookings.filter(b => {
    const eventDate = new Date(b.date);
    return eventDate.getFullYear() === currentYear && b.status !== 'cancelled';
  }).forEach(b => {
    const month = months[new Date(b.date).getMonth()];
    if (month) stats.monthlyBreakdown[month]++;
  });

  // Payment status groups
  const awaitingDepositBookings = bookings.filter(b =>
    b.status === 'pending' && !b.depositPaid
  ).sort((a, b) => new Date(a.date) - new Date(b.date));

  const depositPaidBookings = bookings.filter(b =>
    b.status === 'pending' && b.depositPaid === true
  ).sort((a, b) => new Date(a.date) - new Date(b.date));

  const confirmedBookings = bookings.filter(b => b.status === 'confirmed').sort((a, b) => new Date(a.date) - new Date(b.date));

  const balanceDueBookings = bookings.filter(b =>
    b.status === 'confirmed' && b.fromKV && !b.balancePaid
  );

  // This week
  const weekEnd = new Date(today);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const thisWeekBookings = bookings.filter(b => {
    const d = new Date(b.date);
    return d >= today && d < weekEnd && b.status !== 'cancelled';
  });
  const weekConfirmed = thisWeekBookings.filter(b => b.status === 'confirmed');
  const weekRevenue = weekConfirmed.reduce((sum, b) => sum + (b.total || 0), 0);

  // This month
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const thisMonthConfirmed = bookings.filter(b => {
    const d = new Date(b.date);
    return d >= monthStart && d <= monthEnd && b.status === 'confirmed';
  });
  const monthRevenue = thisMonthConfirmed.reduce((sum, b) => sum + (b.total || 0), 0);
  const monthName = today.toLocaleString('en-GB', { month: 'short' });

  // Event type helpers
  function getEventTypeClass(eventType) {
    if (!eventType) return '';
    const type = eventType.toLowerCase();
    if (type.includes('birthday')) return 'type-birthday';
    if (type.includes('bridal') || type.includes('hen')) return 'type-bridal';
    if (type.includes('baby') || type.includes('shower')) return 'type-baby';
    if (type.includes('workshop') || type.includes('class')) return 'type-workshop';
    if (type.includes('corporate') || type.includes('business')) return 'type-corporate';
    if (type.includes('photo') || type.includes('shoot')) return 'type-photo';
    return 'type-other';
  }

  function getBadgeClass(eventType) {
    if (!eventType) return 'badge-hire';
    const type = eventType.toLowerCase();
    if (type.includes('birthday')) return 'badge-birthday';
    if (type.includes('bridal') || type.includes('hen')) return 'badge-bridal';
    if (type.includes('baby') || type.includes('shower')) return 'badge-birthday';
    if (type.includes('workshop') || type.includes('class')) return 'badge-workshop';
    if (type.includes('corporate') || type.includes('business')) return 'badge-corporate';
    if (type.includes('photo') || type.includes('shoot')) return 'badge-birthday';
    if (type.includes('content')) return 'badge-content';
    return 'badge-hire';
  }

  function getDotColor(eventType) {
    if (!eventType) return 'var(--text-3)';
    const type = eventType.toLowerCase();
    if (type.includes('birthday')) return 'var(--pink)';
    if (type.includes('bridal') || type.includes('hen')) return 'var(--rose)';
    if (type.includes('baby') || type.includes('shower')) return 'var(--pink)';
    if (type.includes('workshop') || type.includes('class')) return 'var(--blue)';
    if (type.includes('corporate') || type.includes('business')) return '#818cf8';
    if (type.includes('photo') || type.includes('shoot')) return 'var(--pink)';
    return 'var(--text-3)';
  }

  // Dedup (same as v1)
  const allActiveBookings = bookings.filter(b => b.status !== 'cancelled');
  const seenKeys = new Map();
  const hideIds = new Set();

  allActiveBookings.forEach(b => {
    try {
      const name = (b.name || '').toLowerCase().trim();
      if (!b.date) return;
      const dateObj = new Date(b.date);
      if (isNaN(dateObj.getTime())) return;
      const date = dateObj.toISOString().slice(0, 10);
      const key = name + '-' + date;
      const isNew = b.fromKV || b.calendarSource === 'hibiscusstudiolondon';

      if (seenKeys.has(key)) {
        const existing = seenKeys.get(key);
        const existingIsNew = existing.fromKV || existing.calendarSource === 'hibiscusstudiolondon';
        if (isNew && !existingIsNew) {
          hideIds.add(existing.id);
          seenKeys.set(key, b);
        } else {
          hideIds.add(b.id);
        }
      } else {
        seenKeys.set(key, b);
      }
    } catch (e) {}
  });

  const deduped = allActiveBookings.filter(b => !hideIds.has(b.id));

  // Day buckets (7 days)
  const dayBuckets = [];
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayAbbr = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    const dateStr = date.toISOString().slice(0, 10);

    let label;
    if (i === 0) label = 'TODAY';
    else if (i === 1) label = 'TOMORROW';
    else label = dayNames[date.getDay()].toUpperCase();

    const dateLabel = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

    const dayBookings = deduped.filter(b => {
      if (!b.date) return false;
      try {
        const bDate = new Date(b.date).toISOString().slice(0, 10);
        return bDate === dateStr;
      } catch (e) { return false; }
    }).sort((a, b) => {
      const timeA = a.timeSlot || a.startTime || '00:00';
      const timeB = b.timeSlot || b.startTime || '00:00';
      return timeA.localeCompare(timeB);
    });

    dayBuckets.push({
      date: dateStr,
      label: label,
      dateLabel: dateLabel,
      dayAbbr: dayAbbr[date.getDay()],
      dayNum: date.getDate(),
      isToday: i === 0,
      bookings: dayBookings
    });
  }

  function cleanName(name) {
    if (!name) return 'Unknown';
    return name.replace(/^Peerspace Booking,?\s*/i, '').trim() || name;
  }

  // === V2-SPECIFIC COMPUTATIONS ===

  const needActionCount = awaitingDepositBookings.length + depositPaidBookings.length + balanceDueBookings.length;

  // Monthly calendar grid
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const startDayOfWeek = (firstDayOfMonth.getDay() + 6) % 7; // Mon=0
  const monthNameFull = today.toLocaleString('en-GB', { month: 'long' }) + ' ' + today.getFullYear();
  const todayDate = today.getDate();

  // Collect booked dates for this month
  const bookedDatesMap = new Map(); // date-num -> array of bookings
  deduped.forEach(b => {
    if (!b.date) return;
    const d = new Date(b.date);
    if (d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear()) {
      const dayNum = d.getDate();
      if (!bookedDatesMap.has(dayNum)) bookedDatesMap.set(dayNum, []);
      bookedDatesMap.get(dayNum).push(b);
    }
  });

  // Build calendar cells
  const calendarCells = [];
  // Prev month padding
  for (let i = 0; i < startDayOfWeek; i++) {
    const prevMonthDays = new Date(today.getFullYear(), today.getMonth(), 0).getDate();
    calendarCells.push({ num: prevMonthDays - startDayOfWeek + 1 + i, isPast: true, isOtherMonth: true });
  }
  // This month
  let emptyWeekdayCount = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(today.getFullYear(), today.getMonth(), d);
    const dayOfWeek = date.getDay(); // 0=Sun
    const isPast = d < todayDate;
    const isToday = d === todayDate;
    const hasBooking = bookedDatesMap.has(d);
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isEmptyWeekday = !isPast && !hasBooking && !isWeekend && d >= todayDate;
    if (isEmptyWeekday) emptyWeekdayCount++;

    const bookingsForDay = bookedDatesMap.get(d) || [];
    const dots = bookingsForDay.slice(0, 3).map(b => getDotColor(b.eventType));

    calendarCells.push({ num: d, isPast, isToday, hasBooking, isEmptyWeekday, isWeekend, dots, bookingsForDay });
  }

  const bookedDaysCount = bookedDatesMap.size;
  const totalWeekdays = Array.from({length: daysInMonth}, (_, i) => {
    const dow = new Date(today.getFullYear(), today.getMonth(), i + 1).getDay();
    return dow !== 0 && dow !== 6 ? 1 : 0;
  }).reduce((a, b) => a + b, 0);
  const totalWeekends = daysInMonth - totalWeekdays;
  const utilization = daysInMonth > 0 ? Math.round(bookedDaysCount / daysInMonth * 100) : 0;

  // Revenue splits
  const weekendRevenue = thisMonthConfirmed.filter(b => {
    const dow = new Date(b.date).getDay();
    return dow === 0 || dow === 6;
  }).reduce((s, b) => s + (b.total || 0), 0);
  const weekdayRevenue = monthRevenue - weekendRevenue;

  const thisMonthPending = bookings.filter(b => {
    const d = new Date(b.date);
    return d >= monthStart && d <= monthEnd && b.status === 'pending';
  });
  const pendingRevenue = thisMonthPending.reduce((s, b) => s + (b.total || 0), 0);
  const forecastRevenue = monthRevenue + pendingRevenue;

  // Averages
  const confirmedWithTotal = confirmedBookings.filter(b => b.total > 0);
  const avgBookingValue = confirmedWithTotal.length > 0
    ? Math.round(confirmedWithTotal.reduce((s, b) => s + b.total, 0) / confirmedWithTotal.length)
    : 0;

  // Revenue percentages for bar
  const revenueTarget = 16800;
  const wkndPct = revenueTarget > 0 ? Math.round(weekendRevenue / revenueTarget * 100) : 0;
  const wkdyPct = revenueTarget > 0 ? Math.round(weekdayRevenue / revenueTarget * 100) : 0;
  const wkndShare = monthRevenue > 0 ? Math.round(weekendRevenue / monthRevenue * 100) : 0;
  const wkdyShare = monthRevenue > 0 ? Math.round(weekdayRevenue / monthRevenue * 100) : 0;

  // Revenue by source
  const ownEventsRevenue = thisMonthConfirmed.filter(b => b.fromKV && b.calendarSource !== 'peerspace').reduce((s, b) => s + (b.total || 0), 0);
  const hireRevenue = thisMonthConfirmed.filter(b => {
    const t = (b.eventType || '').toLowerCase();
    return t.includes('workshop') || t.includes('hire') || t.includes('studio');
  }).reduce((s, b) => s + (b.total || 0), 0);
  const peerRevenue = thisMonthConfirmed.filter(b =>
    b.calendarSource === 'peerspace' || (b.name || '').toLowerCase().includes('peerspace')
  ).reduce((s, b) => s + (b.total || 0), 0);
  const calOnlyRevenue = thisMonthConfirmed.filter(b => b.fromCalendar && !b.fromKV).reduce((s, b) => s + (b.total || 0), 0);

  // Weekday/Weekend utilization
  const bookedWeekends = Array.from(bookedDatesMap.keys()).filter(d => {
    const dow = new Date(today.getFullYear(), today.getMonth(), d).getDay();
    return dow === 0 || dow === 6;
  }).length;
  const bookedWeekdays = bookedDaysCount - bookedWeekends;
  const weekdayUtil = totalWeekdays > 0 ? Math.round(bookedWeekdays / totalWeekdays * 100) : 0;
  const weekendUtil = totalWeekends > 0 ? Math.round(bookedWeekends / totalWeekends * 100) : 0;

  // Pipeline counts (Tier 1 approximation from booking data)
  const enquiryCount = awaitingDepositBookings.length + depositPaidBookings.length;
  const confirmedUpcomingCount = confirmedBookings.filter(b => new Date(b.date) >= today).length;

  // Overdue deposits (48h+)
  const overdueBookings = awaitingDepositBookings.filter(b => {
    if (!b.createdAt) return false;
    const hours = Math.floor((Date.now() - new Date(b.createdAt).getTime()) / (1000 * 60 * 60));
    return hours >= 48;
  });

  // === QUIET STACK: Pipeline stages + action items ===
  function getPipelineStage(b) {
    if (b.status === 'cancelled') return 'cancelled';
    const eventDate = new Date(b.date);
    if (eventDate < today && b.status === 'confirmed') return 'done';
    if (b.status === 'confirmed') return 'confirmed';
    if (b.depositPaid) return 'deposit';
    return 'enquiry';
  }

  const pipelineCounts = { enquiry: 0, deposit: 0, confirmed: 0, done: 0 };
  deduped.forEach(b => {
    const stage = getPipelineStage(b);
    if (pipelineCounts[stage] !== undefined) pipelineCounts[stage]++;
  });
  const totalPipeline = deduped.length;

  // Build action items (bookings needing human action)
  const actionItems = [];
  awaitingDepositBookings.forEach(b => {
    const hoursOld = b.createdAt ? Math.floor((Date.now() - new Date(b.createdAt).getTime()) / 3600000) : 0;
    actionItems.push(Object.assign({}, b, { actionType: 'overdue', hoursOverdue: hoursOld }));
  });
  depositPaidBookings.forEach(b => {
    actionItems.push(Object.assign({}, b, { actionType: 'confirm' }));
  });
  balanceDueBookings.forEach(b => {
    actionItems.push(Object.assign({}, b, { actionType: 'balance' }));
  });
  actionItems.sort((a, b) => {
    const order = { overdue: 0, confirm: 1, balance: 2 };
    if (order[a.actionType] !== order[b.actionType]) return order[a.actionType] - order[b.actionType];
    if (a.actionType === 'overdue') return (b.hoursOverdue || 0) - (a.hoursOverdue || 0);
    return 0;
  });

  // All upcoming bookings sorted by date for the list
  const allBookingsSorted = deduped.filter(b => {
    const ed = new Date(b.date);
    return ed >= today || b.status === 'confirmed';
  }).sort((a, b) => new Date(a.date) - new Date(b.date));

  // === V2 HELPER FUNCTIONS ===

  function safeName(n) {
    return (n || 'Unknown').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/`/g, '\\`').replace(/\$/g, '\\$');
  }

  function getInitials(name) {
    if (!name) return '??';
    return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  }

  function generateV2ActionCard(b) {
    if (!b.date) return '';
    const eventDate = new Date(b.date);
    if (isNaN(eventDate.getTime())) return '';
    const daysUntil = Math.ceil((eventDate - today) / (1000 * 60 * 60 * 24));

    let actionLabel = '';
    let actionColor = 'var(--orange)';
    let buttons = '';

    if (b.actionType === 'overdue') {
      actionLabel = 'Chase deposit &mdash; ' + (b.hoursOverdue || 0) + 'h overdue';
      actionColor = 'var(--red)';
      buttons = '<button class="btn-deposit" onclick="event.stopPropagation(); markDepositPaid(\'' + b.id + '\')">Deposit Received</button>' +
        '<button class="btn-action-sm" onclick="event.stopPropagation(); showChangeDateModal(\'' + b.id + "','" + b.date + "'," + daysUntil + "," + (b.dateChangeCount||0) + "," + (b.duration||6) + ')">Change</button>' +
        '<button class="btn-action-sm cancel" onclick="event.stopPropagation(); showCancelModal(\'' + b.id + "','" + safeName(b.name) + "','" + b.date + "'," + daysUntil + "," + (b.deposit||150) + "," + (b.total||300) + ')">Cancel</button>';
    } else if (b.actionType === 'confirm') {
      actionLabel = 'Deposit paid &mdash; confirm booking';
      actionColor = 'var(--blue)';
      buttons = '<button class="btn-confirm" onclick="event.stopPropagation(); confirmBooking(\'' + b.id + '\')">&#10003; Confirm</button>' +
        '<button class="btn-action-sm" onclick="event.stopPropagation(); showChangeDateModal(\'' + b.id + "','" + b.date + "'," + daysUntil + "," + (b.dateChangeCount||0) + "," + (b.duration||6) + ')">Change</button>' +
        '<button class="btn-action-sm cancel" onclick="event.stopPropagation(); showCancelModal(\'' + b.id + "','" + safeName(b.name) + "','" + b.date + "'," + daysUntil + "," + (b.deposit||150) + "," + (b.total||300) + ')">Cancel</button>';
    } else if (b.actionType === 'balance') {
      actionLabel = 'Collect balance &mdash; event ' + (daysUntil > 0 ? 'in ' + daysUntil + 'd' : 'today');
      actionColor = 'var(--purple)';
      buttons = '<button class="btn-balance" onclick="event.stopPropagation(); markBalancePaid(\'' + b.id + '\')">Balance Received</button>' +
        '<button class="btn-action-sm" onclick="event.stopPropagation(); showChangeDateModal(\'' + b.id + "','" + b.date + "'," + daysUntil + "," + (b.dateChangeCount||0) + "," + (b.duration||6) + ')">Change</button>' +
        '<button class="btn-action-sm cancel" onclick="event.stopPropagation(); showCancelModal(\'' + b.id + "','" + safeName(b.name) + "','" + b.date + "'," + daysUntil + "," + (b.deposit||150) + "," + (b.total||300) + ')">Cancel</button>';
    }

    var chaseHtml = '';
    if (b.actionType === 'overdue') {
      var hrs = b.hoursOverdue || 0;
      chaseHtml = '<div class="chase">' +
        '<div class="chase-step done" title="Invoice sent"></div>' +
        '<div class="chase-step ' + (hrs >= 24 ? 'done' : 'pending') + '" title="Reminder"></div>' +
        '<div class="chase-step ' + (hrs >= 48 ? (hrs < 120 ? 'active' : 'done') : 'pending') + '" title="48h overdue"></div>' +
        '<div class="chase-step ' + (hrs >= 120 ? 'active' : 'pending') + '" title="5-day"></div>' +
        '<div class="chase-step pending" title="Auto-cancel"></div>' +
        '</div>';
    }

    return '<div class="acard" style="border-left:3px solid ' + actionColor + '" onclick="openDrawer(\'' + b.id + '\')">' +
      '<div class="acard-top">' +
      '<div class="acard-avatar" style="background:' + actionColor + ';color:#fff">' + getInitials(b.name) + '</div>' +
      '<div class="acard-info"><div class="acard-name">' + cleanName(b.name) + '</div>' +
      '<div class="acard-action" style="color:' + actionColor + '">' + actionLabel + '</div></div>' +
      '</div>' +
      chaseHtml +
      '<div class="acard-detail">' + (b.eventType || 'Event') + ' &middot; ' + formatDate(b.date) + (b.total ? ' &middot; &pound;' + b.total : '') + '</div>' +
      '<div class="acard-buttons">' + buttons + '</div>' +
      '</div>';
  }

  function getBookingTime(b) {
    if (b.timeSlot) return b.timeSlot;
    if (b.startTime) {
      // startTime might be ISO datetime or just "HH:MM"
      if (b.startTime.includes('T')) {
        return new Date(b.startTime).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'});
      }
      // Just a time string like "14:00"
      if (/^\d{2}:\d{2}/.test(b.startTime)) return b.startTime.substring(0, 5);
      // Date-only string like "2026-03-08" (all-day event)
      return 'All day';
    }
    return '--:--';
  }

  function generateCalCell(cell) {
    if (cell.isOtherMonth) {
      return '<div class="cal-day past">' + cell.num + '</div>';
    }
    let cls = 'cal-day';
    if (cell.isPast) cls += ' past';
    if (cell.isToday) cls += ' today';
    if (cell.hasBooking) cls += ' has-booking';
    if (cell.isEmptyWeekday) cls += ' empty-weekday';

    const onclick = cell.hasBooking ? ' onclick="openDayDrawer(\'' + cell.num + '\')"' : '';
    let dots = '';
    if (cell.dots && cell.dots.length > 0) {
      dots = '<div class="cal-dots">' + cell.dots.map(function(c) { return '<span style="background:' + c + '"></span>'; }).join('') + '</div>';
    }

    return '<div class="' + cls + '"' + onclick + '>' + cell.num + dots + '</div>';
  }

  function generateBookingRow(b) {
    if (!b.date) return '';
    var stage = getPipelineStage(b);
    if (stage === 'cancelled') return '';
    var eventDate = new Date(b.date);
    if (isNaN(eventDate.getTime())) return '';

    var pillHtml = '';
    var barColor = 'var(--text-3)';
    if (stage === 'enquiry') {
      pillHtml = '<span class="bitem-pill" style="background:var(--red-bg);color:var(--red)">Enquiry</span>';
      barColor = 'var(--red)';
    } else if (stage === 'deposit') {
      pillHtml = '<span class="bitem-pill" style="background:var(--blue-bg);color:var(--blue)">Deposit</span>';
      barColor = 'var(--blue)';
    } else if (stage === 'confirmed') {
      pillHtml = '<span class="bitem-pill" style="background:var(--green-bg);color:var(--green)">Confirmed</span>';
      barColor = 'var(--green)';
    } else if (stage === 'done') {
      pillHtml = '<span class="bitem-pill" style="background:var(--elevated);color:var(--text-3)">Done</span>';
      barColor = 'var(--text-3)';
    }

    return '<div class="bitem" data-stage="' + stage + '" onclick="openDrawer(\'' + b.id + '\')">' +
      '<div class="bitem-color" style="background:' + barColor + '"></div>' +
      '<div class="bitem-info">' +
      '<div class="bitem-name">' + cleanName(b.name) + '</div>' +
      '<div class="bitem-meta">' + (b.eventType || 'Event') + ' &middot; ' + formatDate(b.date) + '</div>' +
      '</div>' +
      (b.total ? '<div class="bitem-price">&pound;' + b.total + '</div>' : '') +
      pillHtml +
      '</div>';
  }

  // Build drawer data JSON entries
  function buildDrawerData() {
    const obj = {};
    deduped.forEach(function(b) {
      if (!b.date) return;
      const eventDate = new Date(b.date);
      if (isNaN(eventDate.getTime())) return;
      const daysUntil = Math.ceil((eventDate - today) / (1000 * 60 * 60 * 24));
      const isPending = b.status === 'pending';
      const isConfirmed = b.status === 'confirmed';
      const isCalendarOnly = b.fromCalendar && !b.fromKV;

      let statusText = isPending && !b.depositPaid ? 'Awaiting deposit'
        : isPending && b.depositPaid ? 'Deposit paid \u2014 awaiting confirmation'
        : isConfirmed && !b.balancePaid ? 'Confirmed \u2014 balance outstanding'
        : isConfirmed ? 'Confirmed & paid'
        : (b.status || 'Unknown');

      const sn = function(v) { return (v || '').replace(/'/g, "\\'"); };
      let actions = [];
      if (isPending && !b.depositPaid && !isCalendarOnly) {
        actions.push({ label: 'Deposit Received', type: 'deposit', onclick: "markDepositPaid('" + b.id + "')" });
        actions.push({ label: 'Change Date', type: 'secondary', onclick: "showChangeDateModal('" + b.id + "','" + b.date + "'," + daysUntil + "," + (b.dateChangeCount||0) + "," + (b.duration||6) + ")" });
        actions.push({ label: 'Cancel', type: 'danger', onclick: "showCancelModal('" + b.id + "','" + sn(b.name) + "','" + b.date + "'," + daysUntil + "," + (b.deposit||150) + "," + (b.total||300) + ")" });
      } else if (isPending && b.depositPaid && !isCalendarOnly) {
        actions.push({ label: 'Confirm Booking', type: 'primary', onclick: "confirmBooking('" + b.id + "')" });
        actions.push({ label: 'Change Date', type: 'secondary', onclick: "showChangeDateModal('" + b.id + "','" + b.date + "'," + daysUntil + "," + (b.dateChangeCount||0) + "," + (b.duration||6) + ")" });
        actions.push({ label: 'Cancel', type: 'danger', onclick: "showCancelModal('" + b.id + "','" + sn(b.name) + "','" + b.date + "'," + daysUntil + "," + (b.deposit||150) + "," + (b.total||300) + ")" });
      } else if (isConfirmed && !b.balancePaid && !isCalendarOnly) {
        actions.push({ label: 'Balance Received', type: 'balance', onclick: "markBalancePaid('" + b.id + "')" });
        actions.push({ label: 'Change Date', type: 'secondary', onclick: "showChangeDateModal('" + b.id + "','" + b.date + "'," + daysUntil + "," + (b.dateChangeCount||0) + "," + (b.duration||6) + ")" });
      } else if (isCalendarOnly) {
        actions.push({ label: 'View in Calendar', type: 'secondary', onclick: "window.open('" + getCalendarDayUrl(b.date) + "')" });
      }

      const sections = [
        { label: 'Event', value: b.eventType || 'Event' },
        { label: 'Date', value: formatDate(b.date) }
      ];
      if (b.total) sections.push({ label: 'Total', value: '\u00A3' + b.total });
      sections.push({ label: 'Status', value: statusText });
      if (b.email) sections.push({ label: 'Email', value: b.email });
      if (b.phone) sections.push({ label: 'Phone', value: b.phone });
      sections.push({ label: 'Source', value: isCalendarOnly ? 'Google Calendar' : 'Booking funnel' });

      obj[b.id] = {
        title: b.name || 'Unknown',
        subtitle: (b.eventType || 'Event') + ' \u00B7 ' + formatDate(b.date),
        sections: sections,
        actions: actions
      };
    });
    return obj;
  }

  function buildDayDrawerData() {
    const obj = {};
    bookedDatesMap.forEach(function(bks, dayNum) {
      const events = bks.map(function(b) {
        const time = getBookingTime(b);
        return {
          time: time,
          name: b.name || 'Unknown',
          type: b.eventType || 'Event',
          status: b.status === 'confirmed' ? 'Confirmed' : b.depositPaid ? 'Deposit Paid' : 'Awaiting Deposit',
          color: getDotColor(b.eventType),
          drawerId: b.id
        };
      });
      const dateObj = new Date(today.getFullYear(), today.getMonth(), dayNum);
      const dateLabel = dateObj.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      obj[dayNum] = { day: dateLabel + (dayNum === todayDate ? ' \u2014 Today' : ''), events: events };
    });
    return obj;
  }

  const drawerDataJson = JSON.stringify(buildDrawerData()).replace(/</g, '\\u003c').replace(/`/g, '\\u0060').replace(/\$/g, '\\u0024');
  const dayDataJson = JSON.stringify(buildDayDrawerData()).replace(/</g, '\\u003c').replace(/`/g, '\\u0060').replace(/\$/g, '\\u0024');

  // === RETURN HTML TEMPLATE ===

  return `
<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#0a0a0a">
<title>Hibiscus Studio — Command Center</title>
<style>
:root {
  --bg: #0a0a0a;
  --surface: #141414;
  --elevated: #1f1f1f;
  --text: #fafafa;
  --text-2: #a3a3a3;
  --text-3: #737373;
  --border: rgba(255,255,255,0.08);
  --green: #4ade80;
  --green-bg: #0f2a1a;
  --red: #ef4444;
  --red-bg: #2a0f0f;
  --orange: #f59e0b;
  --orange-bg: #2a1f0f;
  --blue: #3b82f6;
  --blue-bg: #0f1a2a;
  --purple: #a78bfa;
  --purple-bg: #1a0f2a;
  --pink: #ec4899;
  --rose: #e8b4b8;
  --radius: 10px;
  --touch: 44px;
}
[data-theme="light"] {
  --bg: #ffffff;
  --surface: #f7f7f5;
  --elevated: #ffffff;
  --text: #1a1a1a;
  --text-2: #6b6b6b;
  --text-3: #9b9b9b;
  --border: rgba(0,0,0,0.06);
  --green: #16a34a;
  --green-bg: #f0fdf4;
  --red: #dc2626;
  --red-bg: #fef2f2;
  --orange: #d97706;
  --orange-bg: #fffbeb;
  --blue: #2563eb;
  --blue-bg: #eff6ff;
  --purple: #7c3aed;
  --purple-bg: #f5f3ff;
  --pink: #db2777;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; min-height: 100dvh; }
.header { position: sticky; top: 0; z-index: 100; background: var(--bg); border-bottom: 1px solid var(--border); padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; height: 56px; }
.logo { font-size: 1rem; font-weight: 700; }
.header-right { display: flex; align-items: center; gap: 12px; }
.btn-theme { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); width: 36px; height: 36px; font-size: 16px; cursor: pointer; color: var(--text-2); display: flex; align-items: center; justify-content: center; }
.btn-theme:hover { background: var(--elevated); color: var(--text); }
.theme-icon-light { display: none; }
.theme-icon-dark { display: inline; }
[data-theme="light"] .theme-icon-light { display: inline; }
[data-theme="light"] .theme-icon-dark { display: none; }
.alert-badge { display: flex; align-items: center; gap: 6px; padding: 6px 12px; background: var(--red-bg); border: 1px solid rgba(239,68,68,0.3); border-radius: 20px; font-size: 0.75rem; color: var(--red); font-weight: 600; cursor: pointer; animation: pulse-glow 2s infinite; }
@keyframes pulse-glow { 0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); } 50% { box-shadow: 0 0 8px 2px rgba(239,68,68,0.15); } }
.alert-dot { width: 6px; height: 6px; background: var(--red); border-radius: 50%; }
.content { max-width: 640px; margin: 0 auto; padding: 0 16px 80px; }
.metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--border); border-radius: var(--radius); overflow: hidden; margin: 16px 0; }
.metric { background: var(--surface); padding: 14px 12px; text-align: center; }
.metric .val { font-size: 1.4rem; font-weight: 700; line-height: 1.2; }
.metric .lbl { font-size: 0.65rem; color: var(--text-3); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.5px; }
.section-title { font-size: 0.7rem; color: var(--text-3); text-transform: uppercase; letter-spacing: 1.5px; padding: 20px 0 8px; font-weight: 600; }
.action-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; margin-bottom: 8px; cursor: pointer; }
.action-card .row { display: flex; justify-content: space-between; align-items: center; }
.action-card .name { font-size: 0.9rem; font-weight: 600; }
.action-card .detail { font-size: 0.78rem; color: var(--text-2); margin-top: 4px; }
.action-card .meta { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.badge-sm { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 4px; font-size: 0.68rem; font-weight: 600; }
.badge-birthday { background: #2a1520; color: var(--pink); }
.badge-bridal { background: #1f1525; color: #c4b5fd; }
.badge-workshop { background: #0f1a2a; color: var(--blue); }
.badge-content { background: #1a2a1a; color: var(--green); }
.badge-corporate { background: #0f0f2a; color: #818cf8; }
.badge-hire { background: #1a1a0f; color: #fbbf24; }
.badge-viewing { background: #1a1a1a; color: var(--text-2); }
.badge-peerspace { background: #0f2a2a; color: #22d3ee; }
.badge-urgent { background: var(--red-bg); color: var(--red); animation: pulse-glow 2s infinite; }
.badge-warn { background: var(--orange-bg); color: var(--orange); }
.badge-ok { background: var(--green-bg); color: var(--green); }
.badge-paid { background: var(--green-bg); color: var(--green); }
.badge-unpaid { background: var(--red-bg); color: var(--red); }
[data-theme="light"] .badge-birthday { background: #fdf2f8; }
[data-theme="light"] .badge-bridal { background: #f5f3ff; }
[data-theme="light"] .badge-workshop { background: #eff6ff; }
[data-theme="light"] .badge-corporate { background: #eef2ff; }
[data-theme="light"] .badge-hire { background: #fffbeb; }
.btn { padding: 8px 16px; border-radius: 6px; border: none; font-family: inherit; font-size: 0.78rem; font-weight: 600; cursor: pointer; min-height: var(--touch); display: inline-flex; align-items: center; gap: 6px; }
.btn-primary { background: var(--text); color: var(--bg); }
.btn-secondary { background: var(--elevated); color: var(--text-2); border: 1px solid var(--border); }
.btn-danger { background: var(--red-bg); color: var(--red); border: 1px solid rgba(239,68,68,0.2); }
.btn-sm { padding: 6px 12px; min-height: 32px; font-size: 0.72rem; }
.btn-deposit { padding: 6px 16px; border-radius: 6px; font-size: 0.72rem; font-weight: 600; cursor: pointer; border: none; background: var(--orange); color: #000; }
.btn-confirm { padding: 6px 16px; border-radius: 6px; font-size: 0.72rem; font-weight: 600; cursor: pointer; border: none; background: var(--text); color: var(--bg); }
.btn-balance { padding: 6px 16px; border-radius: 6px; font-size: 0.72rem; font-weight: 600; cursor: pointer; border: none; background: var(--purple); color: #fff; }
.btn-action-sm { padding: 6px 12px; border-radius: 6px; font-size: 0.68rem; font-weight: 500; cursor: pointer; border: 1px solid var(--border); background: transparent; color: var(--text-2); }
.btn-action-sm:hover { border-color: var(--text-3); color: var(--text); }
.btn-action-sm.cancel:hover { border-color: rgba(239,68,68,0.3); color: var(--red); }
.progress-bar { height: 6px; background: var(--elevated); border-radius: 3px; overflow: hidden; margin: 8px 0; }
.progress-fill { height: 100%; border-radius: 3px; }
.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; margin: 12px 0; }
.cal-header { text-align: center; font-size: 0.6rem; color: var(--text-3); text-transform: uppercase; padding: 6px 0; font-weight: 600; }
.cal-day { aspect-ratio: 1; background: var(--surface); border-radius: 6px; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 0.75rem; color: var(--text-2); position: relative; cursor: pointer; border: 1px solid transparent; }
.cal-day.today { border-color: var(--text); color: var(--text); font-weight: 700; }
.cal-day.has-booking { background: var(--green-bg); color: var(--green); font-weight: 600; }
.cal-day.empty-weekday { background: var(--orange-bg); color: var(--orange); border: 1px dashed rgba(245,158,11,0.3); }
.cal-day.past { opacity: 0.3; }
.cal-day .cal-dots { display: flex; gap: 2px; margin-top: 2px; }
.cal-day .cal-dots span { width: 4px; height: 4px; border-radius: 50%; }
/* === QUIET STACK COMPONENTS === */
.util-row { display: flex; align-items: center; gap: 8px; padding: 12px 0 4px; font-size: 0.75rem; color: var(--text-2); }
.util-row strong { color: var(--text); font-weight: 600; }
.money-strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--border); border-radius: var(--radius); overflow: hidden; margin: 8px 0 16px; }
.ms { background: var(--surface); padding: 14px 12px; text-align: center; }
.ms-val { font-size: 1.4rem; font-weight: 700; line-height: 1.2; }
.ms-lbl { font-size: 0.65rem; color: var(--text-3); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.5px; }
.action-well { background: var(--surface); border: 1px solid rgba(245,158,11,0.25); border-radius: var(--radius); padding: 16px; margin-bottom: 16px; }
.action-well-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 0.85rem; font-weight: 700; color: var(--orange); }
.action-well-header .aw-count { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; background: var(--orange); color: #000; border-radius: 50%; font-size: 0.7rem; font-weight: 700; }
.acard { background: var(--elevated); border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 8px; cursor: pointer; }
.acard:last-child { margin-bottom: 0; }
.acard-top { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.acard-avatar { width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 700; flex-shrink: 0; }
.acard-info { flex: 1; min-width: 0; }
.acard-name { font-size: 0.85rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.acard-action { font-size: 0.72rem; font-weight: 500; }
.acard-detail { font-size: 0.72rem; color: var(--text-3); margin-bottom: 8px; }
.acard-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
.chase { display: flex; align-items: center; gap: 0; margin: 6px 0; }
.chase-step { flex: 1; height: 4px; border-radius: 2px; }
.chase-step.done { background: var(--green); }
.chase-step.active { background: var(--orange); animation: pulse-bar 1.5s infinite; }
.chase-step.pending { background: var(--elevated); }
.chase-step + .chase-step { margin-left: 3px; }
@keyframes pulse-bar { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
.pipeline-chips { display: flex; gap: 6px; overflow-x: auto; padding: 16px 0 8px; -webkit-overflow-scrolling: touch; }
.pchip { padding: 6px 14px; border-radius: 20px; font-size: 0.72rem; font-weight: 600; border: 1px solid var(--border); background: var(--surface); color: var(--text-2); cursor: pointer; white-space: nowrap; flex-shrink: 0; }
.pchip.active { background: var(--text); color: var(--bg); border-color: var(--text); }
.pchip:hover:not(.active) { border-color: var(--text-3); color: var(--text); }
.bitem { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 4px; cursor: pointer; }
.bitem-color { width: 3px; height: 28px; border-radius: 2px; flex-shrink: 0; }
.bitem-info { flex: 1; min-width: 0; }
.bitem-name { font-size: 0.82rem; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bitem-meta { font-size: 0.68rem; color: var(--text-3); }
.bitem-price { font-size: 0.78rem; color: var(--text-2); font-weight: 600; flex-shrink: 0; }
.bitem-pill { padding: 2px 8px; border-radius: 4px; font-size: 0.62rem; font-weight: 600; flex-shrink: 0; }
.cal-fab { position: fixed; bottom: 24px; right: 20px; width: 44px; height: 44px; border-radius: 50%; background: var(--surface); border: 1px solid var(--border); color: var(--text-2); font-size: 1.1rem; cursor: pointer; z-index: 150; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(0,0,0,0.4); }
.cal-fab:hover { background: var(--elevated); color: var(--text); }
.cal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 250; display: none; align-items: flex-end; justify-content: center; }
.cal-overlay.open { display: flex; }
.cal-sheet { background: var(--surface); border: 1px solid var(--border); border-radius: 16px 16px 0 0; width: 100%; max-width: 480px; max-height: 80dvh; overflow-y: auto; padding: 12px 16px 32px; }
.cal-sheet .drag-handle { width: 36px; height: 4px; background: var(--text-3); border-radius: 2px; margin: 0 auto 12px; }
.cal-sheet .cal-nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.cal-sheet .cal-nav button { background: none; border: none; color: var(--text-2); font-size: 1rem; cursor: pointer; padding: 4px 8px; }
.cal-sheet .cal-nav span { font-size: 0.85rem; font-weight: 600; color: var(--text); }
.cal-day-detail { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
.cal-day-detail .cdd-title { font-size: 0.8rem; font-weight: 600; margin-bottom: 8px; }
.cal-day-detail .cdd-event { display: flex; align-items: center; gap: 8px; padding: 8px; background: var(--elevated); border-radius: 6px; margin-bottom: 4px; cursor: pointer; }
.cal-day-detail .cdd-event .cdd-time { font-size: 0.72rem; color: var(--text-3); width: 40px; flex-shrink: 0; }
.cal-day-detail .cdd-event .cdd-name { font-size: 0.78rem; font-weight: 500; }
.all-clear { text-align: center; padding: 24px 16px; color: var(--text-3); font-size: 0.82rem; }
.collapsible-header { display: flex; justify-content: space-between; align-items: center; cursor: pointer; padding: 20px 0 8px; user-select: none; }
.collapsible-header .section-title { padding: 0; }
.collapsible-header .chevron { font-size: 0.7rem; color: var(--text-3); transition: transform 0.2s; }
.collapsible-header.open .chevron { transform: rotate(180deg); }
.collapsible-body { display: none; }
.collapsible-body.open { display: block; }
.collapsible-count { font-size: 0.68rem; color: var(--red); font-weight: 600; margin-left: 6px; }
.help-fab { position: fixed; bottom: 76px; right: 20px; width: 48px; height: 48px; border-radius: 50%; background: var(--elevated); border: 1px solid var(--border); color: var(--text-2); font-size: 1.1rem; cursor: pointer; z-index: 150; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(0,0,0,0.4); }
.help-modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 300; }
.help-modal-overlay.open { display: flex; align-items: flex-end; justify-content: center; }
@media (min-width: 768px) { .help-modal-overlay.open { align-items: center; } }
.help-modal { background: var(--surface); border: 1px solid var(--border); border-radius: 16px 16px 0 0; width: 100%; max-width: 480px; padding: 24px 16px 32px; }
@media (min-width: 768px) { .help-modal { border-radius: 16px; } }
.help-modal h3 { font-size: 1rem; margin-bottom: 12px; }
.help-modal textarea { width: 100%; min-height: 100px; background: var(--elevated); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: inherit; font-size: 0.85rem; padding: 12px; resize: vertical; }
.help-modal .help-actions { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; }
.drawer-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 200; }
.drawer-overlay.open { display: block; }
.drawer { position: fixed; z-index: 201; background: var(--surface); border: 1px solid var(--border); overflow-y: auto; transition: transform 0.3s ease; }
@media (max-width: 767px) { .drawer { bottom: 0; left: 0; right: 0; max-height: 85dvh; border-radius: 16px 16px 0 0; transform: translateY(100%); } .drawer.open { transform: translateY(0); } .drawer-handle { display: flex; justify-content: center; padding: 8px; } .drawer-handle::after { content: ''; width: 36px; height: 4px; background: var(--text-3); border-radius: 2px; } }
@media (min-width: 768px) { .drawer { top: 0; right: 0; bottom: 0; width: 420px; border-radius: 0; transform: translateX(100%); } .drawer.open { transform: translateX(0); } .drawer-handle { display: none; } }
.drawer-content { padding: 20px 16px 40px; }
.drawer-content .drawer-title { font-size: 1.1rem; font-weight: 700; margin-bottom: 4px; }
.drawer-content .drawer-subtitle { font-size: 0.78rem; color: var(--text-2); margin-bottom: 16px; }
.drawer-section { margin-bottom: 16px; }
.drawer-section .ds-label { font-size: 0.65rem; color: var(--text-3); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; font-weight: 600; }
.drawer-section .ds-value { font-size: 0.85rem; color: var(--text); }
.drawer-actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
.drawer-close { position: absolute; top: 16px; right: 16px; background: var(--elevated); border: 1px solid var(--border); color: var(--text-2); width: 32px; height: 32px; border-radius: 8px; font-size: 1rem; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.toast { position: fixed; bottom: calc(env(safe-area-inset-bottom) + 80px); left: 50%; transform: translateX(-50%) translateY(100px); background: var(--text); color: var(--bg); padding: 10px 20px; border-radius: 20px; font-size: 0.8rem; font-weight: 500; box-shadow: 0 8px 24px rgba(0,0,0,0.5); opacity: 0; transition: all 0.3s ease; z-index: 1001; }
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 400; display: flex; align-items: center; justify-content: center; }
.modal { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; width: 90%; max-width: 400px; padding: 24px; }
.modal h2 { font-size: 1rem; margin-bottom: 12px; }
.modal-info { margin-bottom: 12px; font-size: 0.85rem; }
.policy-box { background: var(--elevated); border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 16px; font-size: 0.82rem; }
.policy-box.refund { border-color: rgba(74,222,128,0.3); }
.policy-box.no-refund { border-color: rgba(239,68,68,0.3); }
.form-group { margin-bottom: 12px; }
.form-group label { display: block; font-size: 0.75rem; color: var(--text-2); margin-bottom: 4px; }
.form-group input, .form-group select { width: 100%; padding: 8px 12px; background: var(--elevated); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: inherit; font-size: 0.85rem; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
.modal-btn { padding: 8px 16px; border-radius: 8px; border: none; font-family: inherit; font-size: 0.82rem; font-weight: 600; cursor: pointer; min-height: 40px; }
.modal-btn.secondary { background: var(--elevated); color: var(--text-2); border: 1px solid var(--border); }
.modal-btn.danger { background: var(--red-bg); color: var(--red); }
.modal-btn.primary { background: var(--text); color: var(--bg); }
</style>
</head>
<body>

<div class="header">
  <div class="logo">Hibiscus Studio</div>
  <div class="header-right">
    ${actionItems.length > 0 ? '<div class="alert-badge" onclick="document.querySelector(\'.action-well\').scrollIntoView({behavior:\'smooth\'})"><span class="alert-dot"></span>&#9889; ' + actionItems.length + ' need you</div>' : ''}
    <button class="btn-theme" onclick="toggleTheme()" title="Toggle light/dark mode">
      <span class="theme-icon-dark">&#9788;</span>
      <span class="theme-icon-light">&#9790;</span>
    </button>
  </div>
</div>

<div class="content">

  <!-- Utilization bar -->
  <div class="util-row">This week: <strong>${thisWeekBookings.length} bookings</strong> &middot; ${utilization}% utilised</div>

  <!-- Money strip -->
  <div class="money-strip">
    <div class="ms">
      <div class="ms-val" style="color:var(--green)">&pound;${monthRevenue.toLocaleString()}</div>
      <div class="ms-lbl">Confirmed</div>
    </div>
    <div class="ms">
      <div class="ms-val" style="color:var(--orange)">&pound;${pendingRevenue.toLocaleString()}</div>
      <div class="ms-lbl">Pending</div>
    </div>
    <div class="ms">
      <div class="ms-val">&pound;${forecastRevenue.toLocaleString()}</div>
      <div class="ms-lbl">Forecast</div>
    </div>
  </div>

  <!-- Action well -->
  ${actionItems.length > 0 ? '<div class="action-well"><div class="action-well-header"><span class="aw-count">' + actionItems.length + '</span> need you</div>' + actionItems.map(generateV2ActionCard).join('') + '</div>' : '<div class="all-clear">All clear &mdash; no actions needed</div>'}

  <!-- Pipeline filter chips -->
  <div class="pipeline-chips">
    <button class="pchip active" onclick="filterPipeline('all', this)">All ${totalPipeline}</button>
    ${pipelineCounts.enquiry > 0 ? '<button class="pchip" onclick="filterPipeline(\'enquiry\', this)">Enquiry ' + pipelineCounts.enquiry + '</button>' : ''}
    ${pipelineCounts.deposit > 0 ? '<button class="pchip" onclick="filterPipeline(\'deposit\', this)">Deposit ' + pipelineCounts.deposit + '</button>' : ''}
    ${pipelineCounts.confirmed > 0 ? '<button class="pchip" onclick="filterPipeline(\'confirmed\', this)">Confirmed ' + pipelineCounts.confirmed + '</button>' : ''}
    ${pipelineCounts.done > 0 ? '<button class="pchip" onclick="filterPipeline(\'done\', this)">Done ' + pipelineCounts.done + '</button>' : ''}
  </div>

  <!-- Booking list -->
  <div id="bookingList">
  ${allBookingsSorted.length > 0 ? allBookingsSorted.map(generateBookingRow).join('') : '<div style="text-align:center;padding:20px;color:var(--text-3);font-size:0.82rem">No upcoming bookings</div>'}
  </div>

  <!-- Mini calendar -->
  <div class="section-title" style="margin-top:20px">${monthNameFull}</div>
  <div class="cal-grid">
    <div class="cal-header">Mon</div><div class="cal-header">Tue</div><div class="cal-header">Wed</div><div class="cal-header">Thu</div><div class="cal-header">Fri</div><div class="cal-header">Sat</div><div class="cal-header">Sun</div>
    ${calendarCells.map(generateCalCell).join('\n    ')}
  </div>

</div><!-- /content -->

<!-- Floating calendar FAB -->
<button class="cal-fab" onclick="toggleCalOverlay()" title="Calendar">&#128197;</button>

<!-- Calendar overlay -->
<div class="cal-overlay" id="calOverlay" onclick="toggleCalOverlay()">
  <div class="cal-sheet" onclick="event.stopPropagation()">
    <div class="drag-handle"></div>
    <div class="cal-nav">
      <span>${monthNameFull}</span>
    </div>
    <div class="cal-grid">
      <div class="cal-header">Mon</div><div class="cal-header">Tue</div><div class="cal-header">Wed</div><div class="cal-header">Thu</div><div class="cal-header">Fri</div><div class="cal-header">Sat</div><div class="cal-header">Sun</div>
      ${calendarCells.map(function(cell) {
        if (cell.isOtherMonth) return '<div class="cal-day past">' + cell.num + '</div>';
        var cls = 'cal-day';
        if (cell.isPast) cls += ' past';
        if (cell.isToday) cls += ' today';
        if (cell.hasBooking) cls += ' has-booking';
        var onclick = cell.hasBooking ? ' onclick="showCalDay(' + cell.num + ')"' : '';
        var dots = '';
        if (cell.dots && cell.dots.length > 0) {
          dots = '<div class="cal-dots">' + cell.dots.map(function(c) { return '<span style="background:' + c + '"></span>'; }).join('') + '</div>';
        }
        return '<div class="' + cls + '"' + onclick + '>' + cell.num + dots + '</div>';
      }).join('\n      ')}
    </div>
    <div class="cal-day-detail" id="calDayDetail"></div>
  </div>
</div>

<!-- DETAIL DRAWER -->
<div class="drawer-overlay" id="drawerOverlay" onclick="closeDrawer()"></div>
<div class="drawer" id="drawer">
  <div class="drawer-handle"></div>
  <button class="drawer-close" onclick="closeDrawer()">&times;</button>
  <div class="drawer-content" id="drawerContent"></div>
</div>

<div id="toast" class="toast"></div>

<button class="help-fab" onclick="openHelp()" title="Report an issue">?</button>

<div class="help-modal-overlay" id="helpOverlay" onclick="closeHelp()">
  <div class="help-modal" onclick="event.stopPropagation()">
    <h3>Report an issue</h3>
    <textarea id="helpText" placeholder="What looks wrong? Describe what you expected vs what you see..."></textarea>
    <div class="help-actions">
      <button class="btn btn-secondary btn-sm" onclick="closeHelp()">Cancel</button>
      <button class="btn btn-primary btn-sm" onclick="submitHelp()">Submit</button>
    </div>
  </div>
</div>

<script>
/* Theme toggle */
(function() {
  var savedTheme = localStorage.getItem('hb-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
})();

function toggleTheme() {
  var current = document.documentElement.getAttribute('data-theme') || 'dark';
  var next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('hb-theme', next);
}

/* Calendar overlay */
function toggleCalOverlay() {
  document.getElementById('calOverlay').classList.toggle('open');
}

/* Show day detail in calendar overlay */
function showCalDay(dayNum) {
  var d = dayData[dayNum];
  var el = document.getElementById('calDayDetail');
  if (!d || !el) return;
  var html = '<div class="cdd-title">' + d.day + '</div>';
  d.events.forEach(function(ev) {
    html += '<div class="cdd-event"' + (ev.drawerId ? ' onclick="toggleCalOverlay(); openDrawer(\'' + ev.drawerId + '\')"' : '') + '>';
    html += '<div class="cdd-time">' + ev.time + '</div>';
    html += '<div class="cdd-name">' + ev.name + ' &middot; ' + ev.type + '</div>';
    html += '</div>';
  });
  el.innerHTML = html;
}

/* Pipeline filter chips */
function filterPipeline(stage, btn) {
  document.querySelectorAll('.pchip').forEach(function(c) { c.classList.remove('active'); });
  btn.classList.add('active');
  document.querySelectorAll('.bitem').forEach(function(row) {
    if (stage === 'all') {
      row.style.display = '';
    } else {
      row.style.display = row.getAttribute('data-stage') === stage ? '' : 'none';
    }
  });
}

/* Toast */
function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function() { t.classList.remove('show'); }, 3000);
}

/* Keyboard shortcuts */
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') { closeDrawer(); closeHelp(); var co = document.getElementById('calOverlay'); if (co) co.classList.remove('open'); }
});

/* Help modal */
function openHelp() { document.getElementById('helpOverlay').classList.add('open'); }
function closeHelp() { document.getElementById('helpOverlay').classList.remove('open'); }
function submitHelp() {
  var msg = document.getElementById('helpText').value.trim();
  if (!msg) return;
  showToast('Ticket submitted!');
  document.getElementById('helpText').value = '';
  closeHelp();
}

function closeDrawer() {
  document.getElementById('drawerOverlay').classList.remove('open');
  document.getElementById('drawer').classList.remove('open');
}
</script>
<script>
/* Debug: check if this script block loads */
window.__v2ScriptLoaded = true;
var dayData = {};
var drawerData = {};
try {
  dayData = ${dayDataJson};
  drawerData = ${drawerDataJson};
} catch(e) {
  document.getElementById('toast').textContent = 'Data parse error: ' + e.message;
  document.getElementById('toast').classList.add('show');
  console.error('V2 Data Parse Error:', e);
}

/* Calendar day drawer */

function openDayDrawer(dayId) {
  var d = dayData[dayId];
  if (!d) return;
  var html = '<div class="drawer-title">' + d.day + '</div>';
  html += '<div class="drawer-subtitle">' + d.events.length + ' event' + (d.events.length !== 1 ? 's' : '') + '</div>';
  d.events.forEach(function(ev) {
    html += '<div class="event-row" style="margin-bottom:8px;cursor:pointer"' + (ev.drawerId ? ' onclick="openDrawer(\\'' + ev.drawerId + '\\')"' : '') + '>';
    html += '<div class="event-time">' + ev.time + '</div>';
    html += '<div class="event-dot" style="background:' + ev.color + '"></div>';
    html += '<div class="event-info"><div class="ev-name">' + ev.name + '</div><div class="ev-type">' + ev.type + ' &middot; ' + ev.status + '</div></div>';
    html += '</div>';
  });
  document.getElementById('drawerContent').innerHTML = html;
  document.getElementById('drawerOverlay').classList.add('open');
  document.getElementById('drawer').classList.add('open');
}

/* Booking drawer */
function openDrawer(id) {
  var data = drawerData[id];
  if (!data) return;
  var html = '<div class="drawer-title">' + data.title + '</div>';
  html += '<div class="drawer-subtitle">' + data.subtitle + '</div>';
  data.sections.forEach(function(s) {
    html += '<div class="drawer-section"><div class="ds-label">' + s.label + '</div><div class="ds-value">' + s.value + '</div></div>';
  });
  if (data.actions && data.actions.length) {
    html += '<div class="drawer-actions">';
    data.actions.forEach(function(a) {
      var cls = a.type === 'deposit' ? 'btn-deposit' : a.type === 'balance' ? 'btn-balance' : a.type === 'primary' ? 'btn btn-primary' : a.type === 'danger' ? 'btn btn-danger' : 'btn btn-secondary';
      html += '<button class="' + cls + '" onclick="' + (a.onclick || "showToast('Preview only')") + '">' + a.label + '</button>';
    });
    html += '</div>';
  }
  document.getElementById('drawerContent').innerHTML = html;
  document.getElementById('drawerOverlay').classList.add('open');
  document.getElementById('drawer').classList.add('open');
}

/* === PRODUCTION API FUNCTIONS === */

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) btn.classList.add('copied');
    showToast('Copied: ' + text);
    if (btn) setTimeout(function() { btn.classList.remove('copied'); }, 2000);
  } catch (e) {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Copied: ' + text);
  }
}

async function confirmBooking(id) {
  try {
    var res = await fetch('/api/bookings/'+id+'/confirm', { method: 'POST', credentials: 'include' });
    if (res.ok) {
      showToast('Booking confirmed');
      setTimeout(function() { location.reload(); }, 1500);
    } else { throw new Error('Failed'); }
  } catch (e) { showToast('Error - try again'); }
}

async function markDepositPaid(id) {
  try {
    var res = await fetch('/api/bookings/'+id+'/mark-deposit-paid', { method: 'POST', credentials: 'include' });
    if (res.ok) {
      showToast('Deposit marked as paid');
      setTimeout(function() { location.reload(); }, 1500);
    } else {
      var data = await res.json();
      throw new Error(data.error || 'Failed');
    }
  } catch (e) { showToast('Error: ' + e.message); }
}

async function markBalancePaid(id) {
  try {
    var res = await fetch('/api/bookings/'+id+'/mark-balance-paid', { method: 'POST', credentials: 'include' });
    if (res.ok) {
      showToast('Balance marked as paid');
      setTimeout(function() { location.reload(); }, 1500);
    } else {
      var data = await res.json();
      throw new Error(data.error || 'Failed');
    }
  } catch (e) { showToast('Error: ' + e.message); }
}

function showCancelModal(id, name, date, days, deposit, total) {
  var isRefund = days >= 7;
  var modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'cancelModal';
  modal.innerHTML = '<div class="modal"><h2>Cancel Booking</h2>' +
    '<div class="modal-info"><p><strong>' + name + '</strong></p><p>' + formatDateJS(date) + '</p></div>' +
    '<div class="policy-box ' + (isRefund ? 'refund' : 'no-refund') + '">' +
    '<p><strong>' + days + ' days notice</strong></p>' +
    '<p>' + (isRefund ? 'Deposit (&pound;'+deposit+') forfeit. Balance refunded if paid.' : 'No refund available (<7 days notice).') + '</p></div>' +
    '<div class="modal-actions">' +
    '<button class="modal-btn secondary" onclick="closeModal(\\'cancelModal\\')">Keep</button>' +
    '<button class="modal-btn danger" onclick="cancelBooking(\\'' + id + '\\')">Cancel</button></div></div>';
  document.body.appendChild(modal);
}

async function cancelBooking(id) {
  var btn = document.querySelector('#cancelModal .danger');
  btn.textContent = 'Cancelling...';
  btn.disabled = true;
  try {
    var res = await fetch('/api/bookings/'+id+'/cancel', { method: 'POST', credentials: 'include' });
    if (res.ok) {
      closeModal('cancelModal');
      showToast('Booking cancelled');
      setTimeout(function() { location.reload(); }, 1500);
    } else { throw new Error('Failed'); }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Cancel';
    showToast('Error - try again');
  }
}

var _changeDuration = 6;

function showChangeDateModal(id, date, days, changes, duration) {
  if (changes >= 1) { alert('Already changed once. Second change = cancellation.'); return; }
  _changeDuration = duration || 6;
  var fee = days >= 7 ? 'Free' : '&pound;50 fee';
  var durationLabel = _changeDuration + 'h booking';
  var modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'changeDateModal';
  modal.innerHTML = '<div class="modal"><h2>Change Date</h2>' +
    '<div class="policy-box"><p><strong>' + fee + '</strong> (' + days + ' days notice)</p>' +
    '<p style="font-size:12px;color:var(--text-3);margin-top:4px;">' + durationLabel + ' &mdash; slots match original duration</p></div>' +
    '<div class="form-group"><label>New Date</label><input type="date" id="newDate" min="' + getTomorrow() + '" onchange="fetchSlots(this.value)"></div>' +
    '<div class="form-group"><label>Time Slot</label><select id="newSlot" disabled><option value="">Select a date first</option></select>' +
    '<div id="slotStatus" style="font-size:12px;color:var(--text-3);margin-top:4px;"></div></div>' +
    '<div class="modal-actions">' +
    '<button class="modal-btn secondary" onclick="closeModal(\\'changeDateModal\\')">Cancel</button>' +
    '<button class="modal-btn primary" id="changeBtn" onclick="changeDate(\\'' + id + '\\')" disabled>Change</button></div></div>';
  document.body.appendChild(modal);
}

async function fetchSlots(date) {
  var select = document.getElementById('newSlot');
  var status = document.getElementById('slotStatus');
  var btn = document.getElementById('changeBtn');
  select.innerHTML = '<option value="">Loading...</option>';
  select.disabled = true;
  btn.disabled = true;
  status.textContent = '';
  try {
    var res = await fetch('/api/availability?date=' + date + '&duration=' + _changeDuration);
    var data = await res.json();
    var available = data.slots.filter(function(s) { return s.available; });
    if (available.length === 0) {
      select.innerHTML = '<option value="">No slots available</option>';
      status.textContent = 'All slots booked on this date. Try another day.';
      status.style.color = 'var(--red)';
    } else {
      select.innerHTML = available.map(function(s) { return '<option value="' + s.id + '">' + s.label + (s.surcharge ? ' (+&pound;'+s.surcharge+')' : '') + '</option>'; }).join('');
      select.disabled = false;
      btn.disabled = false;
      status.textContent = available.length + ' of 4 slots available';
      status.style.color = 'var(--green)';
    }
  } catch (e) {
    select.innerHTML = '<option value="">Error loading</option>';
    status.textContent = 'Could not check availability';
    status.style.color = 'var(--red)';
  }
}

async function changeDate(id) {
  var newDate = document.getElementById('newDate').value;
  var newSlot = document.getElementById('newSlot').value;
  if (!newDate || !newSlot) return;
  var btn = document.getElementById('changeBtn');
  btn.textContent = 'Changing...';
  btn.disabled = true;
  try {
    var res = await fetch('/api/bookings/'+id+'/change-date', {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({newDate: newDate, newTimeSlot: newSlot})
    });
    var data = await res.json();
    if (res.ok) {
      closeModal('changeDateModal');
      showToast('Date changed to ' + newDate);
      setTimeout(function() { location.reload(); }, 1500);
    } else { throw new Error(data.message || data.error || 'Failed'); }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Change';
    showToast('Error: ' + e.message);
  }
}

function closeModal(id) { var m = document.getElementById(id); if (m) m.remove(); }
function formatDateJS(d) { return new Date(d).toLocaleDateString('en-GB', {weekday:'short', day:'numeric', month:'short'}); }
function getTomorrow() { var d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0]; }
</script>
<script>
if (typeof openDrawer === 'undefined') {
  document.getElementById('toast').textContent = 'SCRIPT LOAD FAILED - openDrawer not defined. Check console.';
  document.getElementById('toast').classList.add('show');
  setTimeout(function(){ document.getElementById('toast').classList.remove('show'); }, 10000);
}
if (typeof dayData !== 'undefined') {
  document.title = 'HBS v2 [' + Object.keys(dayData).length + ' days, ' + Object.keys(drawerData).length + ' bookings]';
}
</script>

</body>
</html>
  `;
}

function formatDate(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

// ============================================
// Calculator Lead Capture
// ============================================

router.post('/api/calculator-lead', async (request, env) => {
  try {
    const body = await request.json();
    const { igHandle } = body;

    if (!igHandle || igHandle.trim().length < 2) {
      return json({ error: 'Instagram handle is required' }, 400);
    }

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const lead = {
      id,
      igHandle: igHandle.trim(),
      type: body.type || 'other',
      typeLabel: body.typeLabel || '',
      ticket: body.ticket || 0,
      attendees: body.attendees || 0,
      duration: body.duration || 0,
      venue: body.venue || 0,
      materials: body.materials || 0,
      profit: body.profit || 0,
      timestamp: body.timestamp || new Date().toISOString(),
      breakdownUrl: '/calculator/b/?id=' + id
    };

    await env.BOOKINGS.put('calc-lead:' + id, JSON.stringify(lead), {
      expirationTtl: 60 * 60 * 24 * 90
    });

    // Telegram notification (non-blocking — won't fail the response)
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      const fullUrl = 'https://hibiscusstudio.co.uk' + lead.breakdownUrl;
      const cleanHandle = lead.igHandle.replace(/^@/, '');
      const igLink = 'https://www.instagram.com/' + cleanHandle + '/';
      const msg1 = `\u{1F4E9} New calculator lead\n\nIG: ${lead.igHandle}\nType: ${lead.typeLabel || lead.type}\nProfit: \u00A3${lead.profit}\nTicket: \u00A3${lead.ticket} \u00D7 ${lead.attendees} pax\n\n\u{1F517} Open their profile & DM:\n${igLink}`;
      const msg2 = `Hey ${lead.igHandle}! Here\u2019s your personalised workshop breakdown \u{1F447}\n\n${fullUrl}`;
      const tgUrl = 'https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage';
      try {
        const threadId = env.TELEGRAM_THREAD_ID ? Number(env.TELEGRAM_THREAD_ID) : undefined;
        const base = { chat_id: env.TELEGRAM_CHAT_ID };
        if (threadId) base.message_thread_id = threadId;
        await fetch(tgUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, text: msg1 }) });
        await fetch(tgUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, text: msg2 }) });
      } catch (e) { /* silent — don't break lead capture */ }
    }

    return json({ ok: true, id, breakdownUrl: lead.breakdownUrl });
  } catch (error) {
    return json({ error: error.message }, 500);
  }
});

router.get('/api/calculator-lead', async (request, env) => {
  try {
    const list = await env.BOOKINGS.list({ prefix: 'calc-lead:' });
    const leads = [];
    for (const key of list.keys) {
      const data = await env.BOOKINGS.get(key.name);
      if (data) {
        const lead = JSON.parse(data);
        leads.push({
          id: lead.id,
          igHandle: lead.igHandle,
          type: lead.typeLabel || lead.type,
          profit: lead.profit,
          timestamp: lead.timestamp,
          breakdownUrl: 'https://hibiscusstudio.co.uk' + lead.breakdownUrl
        });
      }
    }
    return json({ leads });
  } catch (error) {
    return json({ error: error.message }, 500);
  }
});

router.get('/api/calculator-lead/:id', async (request, env) => {
  try {
    const { id } = request.params;
    const data = await env.BOOKINGS.get('calc-lead:' + id);
    if (!data) {
      return json({ error: 'Breakdown not found or expired' }, 404);
    }
    return json(JSON.parse(data));
  } catch (error) {
    return json({ error: error.message }, 500);
  }
});

// ============================================
// 404 Handler
// ============================================

router.all('*', () => json({ error: 'Not found' }, 404));

// ============================================
// Export
// ============================================

export default {
  fetch: router.handle,
};
