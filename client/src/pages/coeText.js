import { createElement, Fragment } from 'react';

// The wording of a Certificate of Employment (2026-11-10): HR may edit the body of the letter. The
// standard wording is built here from the certificate's fields, so the form can start the editor
// from it and the print can fall back to it when nothing was edited (body_text empty).
//
// Paragraphs are separated by a blank line; **double asterisks** print in bold, as the names and the
// company are in the standard wording.
//   standard     body_text = every paragraph between the title and the signature
//   with_rating  body_text = the paragraph above the appraisal table; body_closing = those after
//                Mode of Separation / Clearance Status

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const parts = (v) => {
  const [y, m, d] = String(v || '').slice(0, 10).split('-').map(Number);
  return y ? { y, m, d } : null;
};
export const longDate = (v) => { const p = parts(v); return p ? `${MONTHS[p.m - 1]} ${p.d}, ${p.y}` : ''; };
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

export function defaultWording(coe) {
  const his = { he: 'his', she: 'her' }[coe.pronoun] || 'his/her';
  const he = { he: 'he', she: 'she' }[coe.pronoun] || 'he/she';
  const issued = parts(coe.issued_date);
  const givenOn = issued ? `${ordinal(issued.d)} day of ${MONTHS[issued.m - 1]} ${issued.y}` : '___ day of ________';
  const to = coe.date_to ? longDate(coe.date_to) : 'present';
  const name = coe.employee_name || '____________';
  const position = coe.position_title || '____________';
  const issuedTo = coe.issued_to || coe.employee_name || '____________';
  const from = longDate(coe.date_from) || '____________';
  if (coe.coe_type === 'with_rating') {
    return {
      body: `This is to certify that **${name}** was employed with **CEBU GRAPHICSTAR IMAGING CORPORATION** as a **${position}** from ${from} to ${to}.`,
      closing: [
        `This certificate is issued upon request of **${issuedTo}** as a proof that ${he} no longer has any accountability due to the company. It is issued for employment purposes and for whatever lawful purpose it may serve ${his} best.`,
        `Issued this ${givenOn} at Basak, Mandaue City, Cebu, Philippines.`,
      ].join('\n\n'),
    };
  }
  return {
    body: [
      `This is to certify that **${name}** has been employed with **CEBU GRAPHICSTAR IMAGING CORPORATION** as a **${position}** from ${from} to ${to}.`,
      `This certification is being issued to **${issuedTo}** for whatever legal purpose it may serve ${his} best.`,
      `Given this ${givenOn} at Basak, Mandaue City, Cebu, Philippines.`,
    ].join('\n\n'),
    closing: '',
  };
}

// "a **b** c" -> ['a ', <b>b</b>, ' c']; single line breaks inside a paragraph are kept.
export function rich(text) {
  return String(text || '').split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((seg, i) => {
    if (/^\*\*[^*]+\*\*$/.test(seg)) return createElement('b', { key: i }, seg.slice(2, -2));
    const lines = seg.split('\n');
    return createElement(Fragment, { key: i }, ...lines.flatMap((l, j) => (j ? [createElement('br', { key: `br${j}` }), l] : [l])));
  });
}

export const paragraphs = (text) => String(text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
