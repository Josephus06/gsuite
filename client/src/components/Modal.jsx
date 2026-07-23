// `large` is the common wide modal (820px); `xl` (1140px) is for forms carrying a
// full line-item grid, where 820px leaves most columns behind a horizontal scroll.
export default function Modal({ title, onClose, children, large, xl }) {
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${xl ? 'modal-xl' : large ? 'modal-lg' : ''}`}>
        <div className="page-header">
          <h2>{title}</h2>
          <button className="btn btn-sm" onClick={onClose} type="button">Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}
