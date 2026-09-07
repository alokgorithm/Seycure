/**
 * Fixture check for the sensitive-text detection patterns.
 *
 * Run with `npm run verify:patterns`. No test framework: Node strips the
 * types and runs the file directly, so this stays dependency-free.
 *
 * Positive cases must produce a finding of the named type. Negative cases
 * must produce no finding at all — these are the strings that show up in
 * ordinary screenshots and would be annoying to blur.
 */

import { matchPatterns } from '../src/lib/detectionPatterns.ts';

interface PositiveCase {
    text: string;
    expect: string;
    context?: string;
    note?: string;
}

interface NegativeCase {
    text: string;
    context?: string;
    note?: string;
}

const POSITIVES: PositiveCase[] = [
    // ── Email ──────────────────────────────────────────────────────────
    { text: 'Contact: alok.nath@example.com', expect: 'Email Address' },
    { text: 'a_b+tag@sub.domain.co.in', expect: 'Email Address' },

    // ── Phone, with country code ───────────────────────────────────────
    { text: '+91 98765 43210', expect: 'Phone Number' },
    { text: '+919876543210', expect: 'Phone Number' },
    { text: '+91-98765-43210', expect: 'Phone Number' },
    { text: '+1 (415) 555-2671', expect: 'Phone Number', note: 'US' },
    { text: '+44 20 7946 0958', expect: 'Phone Number', note: 'UK' },

    // ── Phone, without country code ────────────────────────────────────
    { text: '9876543210', expect: 'Phone Number', note: 'Indian mobile' },
    { text: '98765 43210', expect: 'Phone Number' },
    { text: '020 7946 0958', expect: 'Phone Number', note: 'UK landline' },
    { text: '(415) 555-2671', expect: 'Phone Number', note: 'US landline' },
    { text: 'Mobile: 98765 43210', expect: 'Phone (with label)' },

    // ── Indian identity documents ──────────────────────────────────────
    { text: '2345 6789 0123', expect: 'Aadhaar Number' },
    { text: '234567890123', expect: 'Aadhaar Number', note: 'unspaced' },
    { text: 'ABCDE1234F', expect: 'PAN Card Number' },
    { text: 'HDFC0001234', expect: 'IFSC Code' },
    { text: 'alok@okhdfcbank', expect: 'UPI / Payment ID' },
    { text: 'K1234567', expect: 'Passport Number', context: 'passport details' },

    // ── Cards and bank accounts ────────────────────────────────────────
    { text: '4111 1111 1111 1111', expect: 'Credit/Debit Card', note: 'Visa' },
    { text: '5500-0000-0000-0004', expect: 'Credit/Debit Card', note: 'Mastercard' },
    { text: '3782 822463 10005', expect: 'Credit/Debit Card', note: 'Amex 15-digit' },
    { text: 'DE89 3704 0044 0532 0130 00', expect: 'IBAN', note: 'Germany' },
    { text: 'GB82 WEST 1234 5698 7654 32', expect: 'IBAN', note: 'UK' },
    { text: 'FR1420041010050500013M02606', expect: 'IBAN', note: 'France, unspaced' },
    { text: 'A/C 50100234567890', expect: 'Bank Account Number', context: 'bank account' },

    // ── Personal details ───────────────────────────────────────────────
    { text: '12/08/1998', expect: 'Date of Birth', context: 'dob' },
    { text: 'House No. 42, Sector 15, Gurgaon', expect: 'Address' },
    { text: 'Name: Alok Nath', expect: 'Named Field' },
    { text: 'Username: alokgorithm', expect: 'Named Field' },
    { text: 'Password: hunter2', expect: 'Password' },

    // ── Network ────────────────────────────────────────────────────────
    { text: '192.168.1.1', expect: 'IP Address', note: 'private' },
    { text: '103.21.244.10', expect: 'IP Address', note: 'public' },

    // ── Shipping ───────────────────────────────────────────────────────
    { text: '1Z999AA10123456784', expect: 'Tracking Number', note: 'UPS' },
    { text: 'EE123456789IN', expect: 'Tracking Number', note: 'India Post S10' },
    { text: 'AWB No: 7761234567', expect: 'Tracking Number (labelled)' },
];

const NEGATIVES: NegativeCase[] = [
    { text: 'Version 2.4.1', note: 'not an IP' },
    { text: '10.0.19041.1', note: 'build number, not an IP' },
    { text: 'Order #12345', note: 'short reference' },
    { text: 'Total: 1,25,000', note: 'rupee amount' },
    { text: '2024-05-12', note: 'plain date, no DOB context' },
    { text: 'ABCDEFGHIJ', note: 'letters only, not a PAN' },
    { text: 'Passengers: 2', note: 'starts with "pass" but is not a password' },
    { text: 'Filename: report.pdf', note: 'ends with "name" but is not a named field' },
    { text: 'Battery 87%', note: 'status bar text' },
    { text: 'Delivered 2:45 PM', note: 'chat timestamp' },
];

// ── Runner ──────────────────────────────────────────────────────────────────

const failures: string[] = [];
let passed = 0;

for (const testCase of POSITIVES) {
    const found = matchPatterns(testCase.text, testCase.context ?? '');
    const hit = found.find(f => f.type === testCase.expect);
    const label = testCase.note ? `${testCase.text}  (${testCase.note})` : testCase.text;

    if (hit) {
        passed++;
        console.log(`  ok   ${label}  ->  ${hit.type}: ${hit.redacted}`);
    } else {
        const other = found.map(f => f.type).join(', ') || 'nothing';
        failures.push(`MISSED  ${label}\n          expected ${testCase.expect}, matched ${other}`);
        console.log(`  MISS ${label}  ->  expected ${testCase.expect}, matched ${other}`);
    }
}

console.log('');

for (const testCase of NEGATIVES) {
    const found = matchPatterns(testCase.text, testCase.context ?? '');
    const label = testCase.note ? `${testCase.text}  (${testCase.note})` : testCase.text;

    if (found.length === 0) {
        passed++;
        console.log(`  ok   ${label}  ->  no match`);
    } else {
        const types = found.map(f => `${f.type} "${f.value}"`).join(', ');
        failures.push(`FALSE POSITIVE  ${label}\n          matched ${types}`);
        console.log(`  FP   ${label}  ->  matched ${types}`);
    }
}

const total = POSITIVES.length + NEGATIVES.length;
console.log(`\n${passed}/${total} pattern fixtures passed.`);

if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):\n`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
}
