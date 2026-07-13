import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import LoadingSpinner from '../components/LoadingSpinner';

// Mirrors the real system's "Print" report for an estimate (Report Viewer ->
// "Price Quotation | No Items" template) -- one line per Job Order (not per process),
// company letterhead, customer/estimate details, totals, terms, and signature blocks.
function num(v) { return v === null || v === undefined || v === '' ? 0 : Number(v); }
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

export default function EstimatePrint() {
  const { id } = useParams();
  const [estimate, setEstimate] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/estimates/${id}`).then(({ data }) => { setEstimate(data); setLoading(false); });
  }, [id]);

  if (loading || !estimate) return <LoadingSpinner />;

  const jobOrders = estimate.jobOrders || [];
  let subtotal = 0;
  let taxTotal = 0;
  const lines = jobOrders.map((jo) => {
    const amount = num(jo.subtotal) - num(jo.disc_amount);
    const tax = amount * (num(jo.tax_rate) / 100);
    subtotal += amount;
    taxTotal += tax;
    const size = [jo.length, jo.width, jo.height].map((v) => (v === null || v === '' ? 0 : v)).join(' x ');
    return { ...jo, amount, size: jo.uom ? `${size} ${jo.uom}` : size };
  });
  const total = subtotal + taxTotal;

  return (
    <div className="estimate-print">
      <div className="print-toolbar">
        <button className="btn btn-primary" onClick={() => window.print()}>Print</button>
      </div>

      <div className="print-sheet">
        <div className="print-letterhead">
          <div className="print-logo">GSUITE ERP</div>
          <div className="print-company-address">
            <strong>GraphicStar Building</strong><br />
            J.S. Alinsug St., Basak Mandaue City, Cebu 6014, Philippines<br />
            Tel. #238-1234<br />
            www.graphicstar.com.ph
          </div>
        </div>

        <h2 className="print-title">Price Quotation</h2>

        <div className="print-info-grid">
          <div>
            <div><strong>Customer :</strong> {estimate.customer_name}</div>
            <div><strong>Attention :</strong> {estimate.contact_name}</div>
            <div><strong>Contact Title :</strong>{estimate.contact_title}</div>
            <div><strong>Contact # :</strong> {estimate.contact_phone}</div>
            <div><strong>Contact Email :</strong> {estimate.contact_email}</div>
            <br />
            <div><strong>Bill To :</strong></div>
            <div><strong>Bill to Address :</strong> {estimate.shipping_address}</div>
            <br />
            <div><strong>Contract Description :</strong> {estimate.contract_description}</div>
            <div><strong>Memo :</strong> {estimate.memo}</div>
          </div>
          <div className="print-info-right">
            <div><strong>Estimate # :</strong> {estimate.estimate_no}</div>
            <div><strong>Date :</strong> {formatDate(estimate.date_created)}</div>
          </div>
        </div>

        <table className="print-items-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Description</th>
              <th>Size</th>
              <th>Quantity</th>
              <th>Units</th>
              <th>Unit Price</th>
              <th>Discount %</th>
              <th>Rate</th>
              <th>Amount (Vat-Ex)</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((jo, idx) => (
              <tr key={jo.id}>
                <td>{idx + 1}.</td>
                <td>{jo.description}</td>
                <td>{jo.size}</td>
                <td>{jo.quantity}</td>
                <td>{jo.units}</td>
                <td>{money(jo.price_per_unit)}</td>
                <td>{money(jo.disc_percent)}</td>
                <td>{money(jo.disc_price_per_unit || jo.price_per_unit)}</td>
                <td>{money(jo.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="print-totals-row">
          <div>
            <div><strong>Payment Terms :</strong> {estimate.credit_term}</div>
            <div><strong>Production Lead Time :</strong> {estimate.production_lead_time}</div>
          </div>
          <div className="print-totals">
            <div><span>Subtotal :</span><span>{money(subtotal)}</span></div>
            <div><span>Tax :</span><span>{money(taxTotal)}</span></div>
            <div className="print-total-final"><span>Total :</span><span>{money(total)}</span></div>
          </div>
        </div>

        <div className="print-terms">
          <h4>Terms and Conditions:</h4>
          <p>1. Delivery date is relative to either of the following:</p>
          <p className="print-indent">- Approval of Final Proof</p>
          <p className="print-indent">- Receipt of Purchase Order and/or Payment</p>
          <p>2. Cancellation of order by oral, written, electronic, or other forms of communication, shall be subject to 25% charge which is based on the TOTAL ORDER AMOUNT.
          The charges shall cover incidental expenses such as Layouting, Site Inspection, Bank Charges and other processing costs. This is applicable only if item/s is/are not produced.</p>

          <h4>Payment Informations:</h4>
          <p>A. For check payments, make all payable to <strong>CEBU GRAPHICSTAR IMAGING CORP.</strong></p>
          <p>B. Money transfer payments must be made to any of <strong>CEBU GRAPHICSTAR IMAGING CORP.</strong> bank accounts only:</p>
          <div className="print-bank-grid">
            <div>1. BPI Savings Account # 9113-0574-13</div>
            <div>2. East West Bank Savings Account # 200005531957</div>
            <div>3. Chinabank Checking Account # 1933824116</div>
            <div>4. Metrobank Checking Account # 236-7-23600587-5</div>
            <div>5. BDO Savings Account # 006360238062</div>
          </div>
          <p>C. For GCASH and PAYMAYA payments, please contact your sales representative for QR codes.</p>
        </div>

        <div className="print-signatures">
          <div>
            <div className="print-sig-label">Prepared By:</div>
            <div className="print-sig-name">{estimate.prepared_by_name}</div>
            <div className="print-sig-line">___________________</div>
          </div>
          <div>
            <div className="print-sig-label">Approved By:</div>
            <div className="print-sig-name">{estimate.approved_by_name}</div>
            <div className="print-sig-line">___________________</div>
          </div>
          <div>
            <div className="print-sig-label">Customer Name/Signature/Date</div>
            <div className="print-sig-name">&nbsp;</div>
            <div className="print-sig-line">___________________</div>
          </div>
        </div>
      </div>
    </div>
  );
}
