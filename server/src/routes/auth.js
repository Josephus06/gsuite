const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    const [[user]] = await pool.query(
      'SELECT * FROM users WHERE (username = ? OR email = ?) AND is_active = TRUE',
      [username, username]
    );
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

    const token = jwt.sign(
      { id: user.id, username: user.username, display_name: user.display_name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        display_name: user.display_name,
        default_branch_id: user.default_branch_id,
        can_approve_sales_estimate: !!user.can_approve_sales_estimate,
        is_design_supervisor: !!user.is_design_supervisor,
        is_supervisor: !!user.is_supervisor,
        is_purchasing_supervisor: !!user.is_purchasing_supervisor,
        account_type: user.account_type,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const [[user]] = await pool.query(
      `SELECT id, username, email, display_name, default_branch_id, employee_id,
              account_type, can_approve_sales_estimate, is_design_supervisor,
              is_account_officer, is_supervisor, is_sales_manager,
              is_sales_marketing_director, is_sales_business_unit, is_purchasing_supervisor, supervisor_id,
              avatar_data
       FROM users WHERE id = ?`,
      [req.user.id]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.can_approve_sales_estimate = !!user.can_approve_sales_estimate;
    user.is_design_supervisor = !!user.is_design_supervisor;
    user.is_account_officer = !!user.is_account_officer;
    user.is_supervisor = !!user.is_supervisor;
    user.is_sales_manager = !!user.is_sales_manager;
    user.is_sales_marketing_director = !!user.is_sales_marketing_director;
    user.is_sales_business_unit = !!user.is_sales_business_unit;
    user.is_purchasing_supervisor = !!user.is_purchasing_supervisor;

    // The "Default Login Location" branch (User Branches tab, is_default = TRUE) --
    // distinct from users.default_branch_id (a separate, legacy field set on the User
    // Account step). This is what auto-fills Office Location/Sales Division when a user
    // starts a new Estimate: their own branch's location + department.
    const [[defaultBranch]] = await pool.query(
      `SELECT ub.location_id, ub.department_id, d.name AS department_name
       FROM user_branches ub
       LEFT JOIN departments d ON d.id = ub.department_id
       WHERE ub.user_id = ? AND ub.is_default = TRUE LIMIT 1`,
      [user.id]
    );
    user.default_branch = defaultBranch || null;

    const [permissions] = await pool.query(
      `SELECT p.route, upp.can_view, upp.can_add, upp.can_edit, upp.can_delete, upp.can_approve
       FROM user_page_permissions upp
       JOIN pages p ON p.id = upp.page_id
       WHERE upp.user_id = ?`,
      [user.id]
    );

    res.json({ user, permissions });
  } catch (err) {
    next(err);
  }
});

// Accepts a data: URL (the client resizes/compresses to a small square JPEG via canvas
// before sending -- see client/src/utils/image.js) rather than a multipart file upload,
// so no disk storage / multer dependency is needed; capped well under the express.json
// body limit to keep rows small since this also gets cached in localStorage.
const AVATAR_DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,/;
const MAX_AVATAR_DATA_URL_LENGTH = 700_000;

router.put('/me/avatar', requireAuth, async (req, res, next) => {
  try {
    const { dataUrl } = req.body;
    if (typeof dataUrl !== 'string' || !AVATAR_DATA_URL_RE.test(dataUrl)) {
      return res.status(400).json({ error: 'Expected a PNG/JPEG/WebP image data URL' });
    }
    if (dataUrl.length > MAX_AVATAR_DATA_URL_LENGTH) {
      return res.status(400).json({ error: 'Image is too large' });
    }
    await pool.query('UPDATE users SET avatar_data = ? WHERE id = ?', [dataUrl, req.user.id]);
    res.json({ avatar_data: dataUrl });
  } catch (err) {
    next(err);
  }
});

router.delete('/me/avatar', requireAuth, async (req, res, next) => {
  try {
    await pool.query('UPDATE users SET avatar_data = NULL WHERE id = ?', [req.user.id]);
    res.json({ avatar_data: null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
