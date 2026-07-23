// One-off script: brings the Non-Standard Job Order master data in line with the live
// GraphicStar system, which is the source of truth for the NSTDJO module.
//
// Verified against the sandbox site (Sales > Non-Standard Job Orders > Add New):
//   * the Job Type lookup offers exactly three jobs -- CUTTING LIST, FILE PREPARATION
//     LAYOUT, SITE INSPECTION. "LED PRODUCT DEMO" is not among them, and the local
//     "DPOD-" prefix on FILE PREPARATION LAYOUT does not exist upstream.
//   * the PMS Job Type lookup is filtered by the chosen Job Type (jobtype.SysFK_Job_JobT
//     = job.SysPK_Job), so every pms_job_types row needs the right job_type_id or the
//     cascading picker comes up empty.
//
// Idempotent -- safe to re-run. Not part of the running app:
//   node src/db/align-nstdjo-master-data.js
const pool = require('../db');
require('dotenv').config();

const NSTDJO_JO_TYPE = 'Non Standard JO';

// Upstream stores no code at all for the SITE INSPECTION variants, but pms_job_types.code
// is NOT NULL with a UNIQUE index, so a code has to exist locally. These SI-* codes are
// generated here (they have no upstream counterpart) -- kept stable and readable so the
// picker, which renders "code — display name", stays legible. Display names are verbatim
// from the live lookup, including its "SIDE INSPECTION - TRANSIT" typo.
const SITE_INSPECTION_TYPES = [
  { code: 'SI-BILLBOARD-FS', display_name: 'SITE INSPECTION - Billboard (Free Standing)' },
  { code: 'SI-MODULAR-DRESSUP', display_name: 'SITE INSPECTION MODULAR DISPLAY - DRESS UP' },
  { code: 'SI-MODULAR-ENDCAP', display_name: 'SITE INSPECTION MODULAR DISPLAY - ENDCAP' },
  { code: 'SI-MODULAR-ISLAND', display_name: 'SITE INSPECTION MODULAR - ISLAND DISPLAY' },
  { code: 'SI-TRANSIT', display_name: 'SIDE INSPECTION - TRANSIT' },
  { code: 'SI-GLASSPANELS4', display_name: 'SITE INSPECTION GLASS PANELS (4)' },
  { code: 'SI-SIGNAGE', display_name: 'SITE INSPECTION - SIGNAGE' },
  { code: 'SI-PYLONSIGNAGE', display_name: 'SITE INSPECTION - PYLON SIGNAGE' },
  { code: 'SI-BILLBOARD-ATT', display_name: 'SITE INSPECTION - Billboard (Attached)' },
  { code: 'SI-WALLSTICKER', display_name: 'SITE INSPECTION - WALL STICKER' },
].map((type) => ({ ...type, minutes_consume: null }));

const FILE_PREP_TYPES = [
  { code: 'COMPSTRUCT', display_name: 'DESIGN_COMPSTRUCT', minutes_consume: 454 },
  { code: 'TSUNEISHI-GRAPHICS-UV', display_name: 'DESIGN_TSUNEISHI (GRAPHICS AND UV) W/ ENCODING', minutes_consume: null },
  { code: 'SOLCEN', display_name: 'DESIGN-BUILD UP - Solution Center (SOLCEN)', minutes_consume: null },
  { code: 'TSUNEISHI-GRAPHICS', display_name: 'DESIGN_TSUNEISHI_GRAPHICS', minutes_consume: null },
  { code: 'DIPHOL', display_name: 'DESIGN_DIPLOMA HOLDER', minutes_consume: null },
  { code: 'TSUNEISHI-UV', display_name: 'DESIGN_TSUNEISHI_UV', minutes_consume: null },
];

async function jobTypeId(displayName) {
  const [[row]] = await pool.query(
    'SELECT id FROM job_types WHERE display_name = ? AND jo_type = ?',
    [displayName, NSTDJO_JO_TYPE],
  );
  return row?.id || null;
}

async function addMissing(types, targetJobTypeId, label) {
  let added = 0;
  for (const type of types) {
    const [[existing]] = await pool.query(
      'SELECT id FROM pms_job_types WHERE display_name = ?',
      [type.display_name],
    );
    if (existing) {
      // Also backfills the code on rows a previous run inserted before codes were assigned.
      await pool.query(
        'UPDATE pms_job_types SET job_type_id = ?, code = IF(code = ?, ?, code) WHERE id = ?',
        [targetJobTypeId, '', type.code, existing.id],
      );
      continue;
    }
    await pool.query(
      'INSERT INTO pms_job_types (code, display_name, minutes_consume, job_type_id) VALUES (?, ?, ?, ?)',
      [type.code, type.display_name, type.minutes_consume, targetJobTypeId],
    );
    added += 1;
    console.log(`  + ${label}: ${type.code || '(no code)'} ${type.display_name}`);
  }
  return added;
}

async function main() {
  // 1. Drop the local "DPOD-" prefix so the job type matches the live lookup.
  const [renamed] = await pool.query(
    'UPDATE job_types SET display_name = ? WHERE display_name = ? AND jo_type = ?',
    ['FILE PREPARATION LAYOUT', 'DPOD-FILE PREPARATION LAYOUT', NSTDJO_JO_TYPE],
  );
  console.log(renamed.affectedRows
    ? 'Renamed "DPOD-FILE PREPARATION LAYOUT" -> "FILE PREPARATION LAYOUT".'
    : 'Job type name already aligned.');

  // 2. LED PRODUCT DEMO is not offered upstream. Deactivated rather than deleted so any
  //    historical rows that reference it keep resolving.
  const [deactivated] = await pool.query(
    'UPDATE job_types SET is_active = FALSE WHERE display_name = ? AND jo_type = ? AND is_active = TRUE',
    ['LED PRODUCT DEMO', NSTDJO_JO_TYPE],
  );
  console.log(deactivated.affectedRows
    ? 'Deactivated "LED PRODUCT DEMO" (not offered on the live site).'
    : '"LED PRODUCT DEMO" already inactive or absent.');

  const filePrepId = await jobTypeId('FILE PREPARATION LAYOUT');
  const siteInspectionId = await jobTypeId('SITE INSPECTION');
  if (!filePrepId || !siteInspectionId) {
    throw new Error(`Expected FILE PREPARATION LAYOUT and SITE INSPECTION job types (got ${filePrepId} / ${siteInspectionId}).`);
  }

  // 3. Every existing PMS job type belongs to FILE PREPARATION LAYOUT -- that is the only
  //    job the local import ever covered.
  const [reparented] = await pool.query(
    'UPDATE pms_job_types SET job_type_id = ? WHERE job_type_id IS NULL OR job_type_id NOT IN (?, ?)',
    [filePrepId, filePrepId, siteInspectionId],
  );
  if (reparented.affectedRows) console.log(`Re-pointed ${reparented.affectedRows} PMS job type(s) at FILE PREPARATION LAYOUT.`);

  const addedFilePrep = await addMissing(FILE_PREP_TYPES, filePrepId, 'FILE PREPARATION LAYOUT');
  const addedSite = await addMissing(SITE_INSPECTION_TYPES, siteInspectionId, 'SITE INSPECTION');
  console.log(`Added ${addedFilePrep} FILE PREPARATION LAYOUT and ${addedSite} SITE INSPECTION PMS job type(s).`);

  const [summary] = await pool.query(
    `SELECT j.display_name, j.is_active, COUNT(p.id) AS pms_count
       FROM job_types j LEFT JOIN pms_job_types p ON p.job_type_id = j.id
      WHERE j.jo_type = ? GROUP BY j.id ORDER BY j.display_name`,
    [NSTDJO_JO_TYPE],
  );
  console.log('\nNon-Standard job types now:');
  console.table(summary);

  await pool.end();
}

main().catch((err) => {
  console.error('Alignment failed:', err);
  process.exit(1);
});
