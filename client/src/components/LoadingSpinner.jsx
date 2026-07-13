import brandMark from '../assets/brand-mark.svg';

const SIZES = { sm: 20, md: 40, lg: 72 };

// Used for every page-level and in-flight loading state (initial fetch, saving a
// transaction, navigating between records) -- one shared visual so "the app is working"
// always looks and feels the same. `inline` renders it next to its label (for use inside
// buttons); otherwise it centers itself with the label stacked underneath.
export default function LoadingSpinner({ label = 'Loading...', size = 'md', inline = false }) {
  const px = SIZES[size] || SIZES.md;
  const mark = <img src={brandMark} alt="" className="loading-spinner-mark" style={{ width: px, height: px }} />;

  if (inline) {
    return (
      <span className="loading-spinner loading-spinner-inline">
        {mark}
        {label && <span>{label}</span>}
      </span>
    );
  }

  return (
    <div className="loading-spinner loading-spinner-block">
      {mark}
      {label && <p className="muted">{label}</p>}
    </div>
  );
}
