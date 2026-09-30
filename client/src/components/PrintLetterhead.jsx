// The real mark, not the app's hand-drawn one (which still drives the loading spinner).
import brandMark from '../assets/graphicstar-mark.png';

// The GraphicStar letterhead, shared by every printed document so they cannot drift apart.
//
// Drawn from the vector mark plus type rather than placed as the bitmap logo: that file carries a
// bevel and a drop shadow, and scaled down to letterhead size it prints muddy -- the same reason
// the emailed PDF sets it in type (see wordmark() in server/src/lib/estimatePdf.js, which this
// matches exactly).
export default function PrintLetterhead() {
  return (
    <div className="print-letterhead">
      <div className="print-logo">
        <img src={brandMark} alt="" className="print-logo-mark" />
        <div className="print-logo-type">
          <div className="print-wordmark">
            <span className="print-wordmark-a">GRAPHIC</span><span className="print-wordmark-b">STAR</span>
          </div>
          <div className="print-wordmark-rule" />
          <div className="print-tagline">Creations Made Easy</div>
        </div>
      </div>
      <div className="print-company-address">
        <strong>GraphicStar Building</strong><br />
        J.S. Alinsug St., Basak Mandaue City, Cebu 6014, Philippines<br />
        Tel. #238-1234<br />
        www.graphicstar.com.ph
      </div>
    </div>
  );
}
