// Shop-ad orders: a local business's offer becomes a short vertical Reel + a WhatsApp poster.

export interface AdBrief {
  businessName: string;
  businessType: string;
  area: string | null;
  offer: string;
  occasion: string | null;
  language: string;
  contactLine: string | null;
  photoUrl: string | null;
}

export const BUSINESS_TYPES = [
  'Sweet shop',
  'Restaurant / cafe',
  'Salon / beauty parlour',
  'Gym / fitness',
  'Clinic / doctor',
  'Clothing / boutique',
  'Jewellery',
  'Mobile / electronics',
  'Coaching class',
  'Real estate',
  'Grocery / kirana',
  'Other',
];

export const OCCASIONS = ['Diwali', 'Navratri / Dussehra', 'Ganpati', 'Gudi Padwa', 'Holi', 'Eid', 'Christmas', 'New year', 'Grand opening', 'Sale', 'Wedding season'];

export const AD_LENGTHS = [15, 20, 30];

/** Devanagari for Marathi/Hindi so the poster text is written in the customer's own script. */
export function scriptFor(language: string): string {
  return /marathi|hindi/i.test(language) ? 'Devanagari script' : 'Latin script';
}

export function adIdea(b: AdBrief): string {
  return `${b.occasion ? b.occasion + ' ' : ''}ad for ${b.businessName}, a ${b.businessType.toLowerCase()}${b.area ? ` in ${b.area}` : ''}. Offer: ${b.offer}.`;
}

export function adPlanPrompt(b: AdBrief, targetSec: number, shots: number): string {
  return [
    `Make a ${targetSec}-second vertical (9:16) Instagram Reel / WhatsApp Status ad for a real local business in India.`,
    `Business: ${b.businessName} — ${b.businessType}${b.area ? `, ${b.area}` : ''}.`,
    `Offer to sell: ${b.offer}.`,
    b.occasion ? `Occasion: ${b.occasion} — use its colours, decorations and mood.` : '',
    `Dialogue language: ${b.language}. Use natural, everyday ${b.language} as people in the area really speak.`,
    b.photoUrl ? 'A reference photo of the real shop/product is attached to every frame; describe settings and products that match it.' : '',
    `Use about ${shots} shots, durations adding up to about ${targetSec} seconds, in this order:`,
    '1. HOOK (first shot): a striking close-up or movement that stops the scroll — the product or the occasion at its most attractive.',
    '2. SHOW: the shop or product in use, warm and inviting; happy local customers (Indian, matching the area).',
    '3. OFFER + INVITE (last shot): the owner or staff smiling at camera, saying the offer and the shop name aloud in one short line.',
    'No on-screen text, logos or prices written in the video — a separate poster carries the text. Keep every line of dialogue short (2–3 words per second).',
    'Title = the shop name. Characters = owner/staff and one or two customers, described consistently.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function posterPrompt(b: AdBrief): string {
  return [
    `Eye-catching vertical 9:16 advertising poster for WhatsApp Status for "${b.businessName}", a ${b.businessType.toLowerCase()}${b.area ? ` in ${b.area}` : ''}.`,
    b.occasion ? `Theme: ${b.occasion}, festive colours and decorations.` : 'Bright, clean, premium look.',
    `Write this text exactly, large and perfectly spelled, in ${scriptFor(b.language)} (${b.language}) where it is not a brand name:`,
    `- Shop name (top, biggest): ${b.businessName}`,
    `- Offer (middle, bold): ${b.offer}`,
    b.contactLine ? `- Contact (bottom): ${b.contactLine}` : '',
    b.photoUrl ? 'Use the attached photo of the real shop/product as the hero image.' : 'Show an attractive hero image of the product or shop.',
    'Clear hierarchy, high contrast, no extra words, no watermarks.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Half the price, rounded up: the minimum advance before any work starts. */
export function minAdvance(priceInr: number): number {
  return Math.ceil(priceInr / 2);
}

export function balanceDue(o: { priceInr: number; advanceInr: number; paid: boolean }): number {
  return o.paid ? 0 : Math.max(0, o.priceInr - o.advanceInr);
}

export function waMessage(o: {
  customerName: string;
  businessName: string;
  videoUrl: string | null;
  posterUrl: string | null;
  priceInr: number;
  advanceInr: number;
  paid: boolean;
}): string {
  const lines = [`Namaskar ${o.customerName} ji 🙏`];
  const need = minAdvance(o.priceInr) - o.advanceInr;
  if (need > 0 && !o.paid) {
    lines.push(`Your ${o.businessName} ad: total ₹${o.priceInr}.`, `Please send ₹${need} advance by UPI to start. We deliver in 24 hours after the advance.`);
  } else {
    lines.push(`Your ${o.businessName} ad is ready.`);
    if (o.videoUrl) lines.push(`Reel: ${o.videoUrl}`);
    if (o.posterUrl) lines.push(`Poster: ${o.posterUrl}`);
    const due = balanceDue(o);
    if (due > 0) lines.push(`Balance: ₹${due} (UPI)`);
  }
  lines.push('Thank you!');
  return lines.join('\n');
}

/** WhatsApp click-to-chat link; Indian 10-digit numbers get the 91 country code. */
export function waLink(phone: string, text: string): string {
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;
  if (digits.length === 11 && digits.startsWith('0')) digits = '91' + digits.slice(1);
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
