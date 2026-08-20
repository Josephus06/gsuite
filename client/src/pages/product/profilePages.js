// The 2025 Company Profile, as flipbook pages.
//
// Content transcribed from the printed profile (flip.pdf). Kept as data rather than markup so
// the flipbook renders every page through the same components -- a page is a `kind` plus its
// content, and the styling lives in one place instead of being copied 23 times.
//
// The product pages carry no photographs: the source artwork is not in the repo, and a broken
// <img> on every tile would look worse than the labelled tiles the profile itself uses. Swap
// `image` onto any item and the tile renders it.

export const BRAND = {
  navy: '#0d2a5c',
  orange: '#f5a623',
  cyan: '#22d3ee',
};

const PAGES = [
  {
    kind: 'cover',
    eyebrow: 'COMPANY',
    title: 'PROFILE 2025',
    subtitle: 'Cebu GraphicStar',
    tagline: 'Creations Made Easy',
  },
  {
    kind: 'text',
    number: '01',
    section: 'About Us',
    heading: 'About Us',
    body: `Now in its 30th year, Cebu GraphicStar is a pioneer and leading visual solutions
provider in the Visayas and Mindanao. From a single creative idea between two visionaries,
it has grown into a trusted name delivering state-of-the-art printing, fabrication, and
digital display solutions — a legacy where creativity, light, and color come together.`,
  },
  {
    kind: 'divider',
    number: '02',
    section: 'Products',
    eyebrow: 'Our',
    title: 'PRODUCTS',
  },
  {
    kind: 'grid',
    number: '03',
    section: 'Products',
    heading: 'LARGE FORMAT PRINT',
    items: [
      'Pull-up Banners', 'Hanging Banners', 'X-Stand Banners', 'Blueprints',
      'Floor Decals', 'Wall Murals', 'Board-up Banners', 'Sticker on Sintra Board',
      'Glass Decals', 'Billboards', 'Vehicle Decals',
    ],
  },
  {
    kind: 'grid',
    number: '04',
    section: 'Products',
    heading: 'SMALL FORMAT PRINT',
    items: [
      'Envelopes', 'Tickets', 'Business Cards', 'Folder Kits',
      'DTF Embossed Stickers', 'Yearbooks', 'Photobooks', 'Flyers',
      'Magazines', 'Letterheads', 'Brochures', 'Notebooks',
      'Tote Bags', 'Lanyards', 'ID Cards', 'Invites',
    ],
  },
  {
    kind: 'grid',
    number: '05',
    section: 'Products',
    heading: 'SIGNAGES & MODULAR DISPLAYS',
    items: [
      'Build-up Signages', 'Projecting Signage', 'Regulatory Signages', 'Backlit Fabric Signages',
      'Beacon Signages', 'Directional Signages', 'Acrylic Displays', 'Room Numbers',
      'Neon Signages', 'Safety Signs', 'Modular Displays', 'Pylon Signages',
    ],
  },
  {
    kind: 'grid',
    number: '06',
    section: 'Products',
    heading: 'FRAMES & AWARDS',
    items: [
      'Wood Frames', 'PVC Frames', 'Canvas Frames', 'Certificates & Diplomas',
      'Acrylic Plaques', 'Acrylic Medals', 'Diploma Holders',
    ],
  },
  {
    kind: 'grid',
    number: '07',
    section: 'Products',
    heading: 'BOOTHS & CARTS',
    items: ['Booths', 'Carts'],
  },
  {
    kind: 'grid',
    number: '08',
    section: 'Products',
    heading: 'APPAREL',
    items: ['Polo Shirts', 'T-Shirts'],
  },
  {
    kind: 'grid',
    number: '09',
    section: 'Products',
    heading: 'DIGITAL DISPLAYS',
    accent: '#e5177f',
    items: [
      'LED Wall Indoor/Outdoor', 'LED Curve', 'LED Fence', 'LED Transparent',
      'LED Platform', 'LED Banner Indoor/Outdoor', 'LCD Topper', 'Flight Case',
    ],
  },
  {
    kind: 'divider',
    number: '10',
    section: 'Our Work',
    eyebrow: 'Some of',
    title: 'OUR WORKS',
  },
  { kind: 'work', number: '11', section: 'Our Work', heading: 'NON-LIGHTED BUILD UP SIGNAGE', client: 'The Pad' },
  { kind: 'work', number: '12', section: 'Our Work', heading: 'NON-LIGHTED BUILD UP SIGNAGE', client: 'Astra Centre' },
  { kind: 'work', number: '13', section: 'Our Work', heading: 'PYLON SIGNAGE', client: 'Astra Centre' },
  { kind: 'work', number: '14', section: 'Our Work', heading: 'LIGHTED FABRIC DISPLAY', client: 'PUMA, Robinsons Galleria' },
  { kind: 'work', number: '15', section: 'Our Work', heading: 'BUILD-UP LIGHTED', client: 'PUMA, Ayala' },
  { kind: 'work', number: '16', section: 'Our Work', heading: 'PYLON SIGNAGE', client: 'Casa Mira Towers Mandaue' },
  { kind: 'work', number: '17', section: 'Our Work', heading: 'BOOTH', client: 'Treasure Island' },
  { kind: 'work', number: '18', section: 'Our Work', heading: 'BOOTH', client: 'Tala, SM Cebu' },
  { kind: 'work', number: '19', section: 'Our Work', heading: 'SINULOG 2026 JOLLIBEE FLOAT', client: 'Jollibee' },
  { kind: 'work', number: '20', section: 'Our Work', heading: 'VEHICLE DECALS', client: 'Jollibee' },
  {
    kind: 'clients',
    number: '21',
    section: 'Trusted by Clients',
    heading: 'Trusted by over 400 clients',
    clients: [
      'Cebu Landmasters', 'Nustar Resort Cebu', 'Lexmark', 'Tsuneishi', 'Radisson Blu',
      'Federal Land', "Rustan's", 'Sony', 'Jollibee', 'Honda', 'Rockwell', 'Robinsons Malls',
      'Tambuli Seaside Resort', 'Amazon', 'Mactan Cebu International Airport', 'Belo Medical Group',
      '7-Eleven', 'Lear', 'Marco Polo Plaza Cebu', 'Johndorf Ventures', 'Ginebra San Miguel',
    ],
    certifications: [
      'PhilGEPS Platinum Membership',
      '3M™ MCS™ Warranty',
      '3M Authorised Convertor — Commercial Graphics',
      'OSHC — BOSH SO1 and SO2 trained team',
    ],
  },
  {
    kind: 'professionals',
    number: '22',
    section: 'Our Professionals',
    heading: 'List of Professionals',
    people: [
      {
        name: 'ENGR. REY F. ESCUADRO',
        role: 'Technical Consultant — Project Management & Construction',
        licenses: [
          'Professional Civil Engineer',
          'Professional Geodetic Engineer',
          'Professional Master Plumber',
          'Professional Registered Master Electrician',
          'Professional Real Estate Broker (Realtor)',
          'Professional Certified Plant Mechanic',
          'DTI/CMDF-COMTCP Accredited Construction Project Superintendent',
          'DPWH Accredited Materials Engineer I',
          'DOLE Accredited (OSH) Safety Practitioner in Construction',
        ],
      },
      {
        name: 'ENGR. JOSE ROE T. BAEL',
        role: 'Structural Engineer',
        licenses: [
          'Registered Civil Engineer (PRC License No. 88973)',
          'Project Management Professional (PMP®)',
          'Association of Structural Engineers of the Philippines (ASEP), Member',
          'Project Management Institute (PMI), Member',
        ],
      },
      {
        name: 'ENGR. RYAN T. RAFAEL',
        role: 'Professional Electrical Engineer',
        licenses: ['Registered Electrical Engineer (PRC License No. 0005145)'],
      },
    ],
  },
  { kind: 'back', tagline: 'Creations Made Easy' },
];

export default PAGES;
