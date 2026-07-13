export default function Modal({ title, onClose, children, large }) {
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${large ? 'modal-lg' : ''}`}>
        <div className="page-header">
          <h2>{title}</h2>
          <button className="btn btn-sm" onClick={onClose} type="button">Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}
