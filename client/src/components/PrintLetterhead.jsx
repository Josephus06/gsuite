// The same logo image the printed forms use (FormPrint, Purchase Order, Job Order, ...).
import letterhead from '../assets/graphicstar-letterhead.png';

// The GraphicStar letterhead, shared by every printed document so they cannot drift apart.
// Sized like the forms' letterhead (52mm wide); the emailed PDF places the same file
// (letterhead() in server/src/lib/estimatePdf.js).
export default function PrintLetterhead() {
  return (
    <div className="print-letterhead">
      <img src={letterhead} alt="GraphicStar Imaging Corp." className="print-logo-img" />
      <div className="print-company-address">
        <strong>GraphicStar Building</strong><br />
        J.S. Alinsug St., Basak Mandaue City, Cebu 6014, Philippines<br />
        Tel. #238-1234<br />
        www.graphicstar.com.ph
      </div>
    </div>
  );
}
