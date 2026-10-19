// Furniture you can place in a room. Sizes are in feet: w is side to side, d is front
// to back, ht is how tall it draws in 3D. At rotation 0 a piece faces the back wall
// (the usual TV wall), so a sofa's backrest is on the side away from it.

export const FURNITURE = {
  tv:          { label: 'TV',              group: 'Screens',  w: 4.8, d: 0.4, ht: 2.8 },
  screen:      { label: 'Projector screen', group: 'Screens', w: 9,   d: 0.3, ht: 5 },
  tvstand:     { label: 'TV stand',        group: 'Screens',  w: 5,   d: 1.5, ht: 1.8 },
  sofa:        { label: 'Sofa',            group: 'Seating',  w: 7,   d: 3,   ht: 2.8 },
  sectional:   { label: 'Sectional',       group: 'Seating',  w: 9,   d: 7,   ht: 2.8 },
  loveseat:    { label: 'Loveseat',        group: 'Seating',  w: 5,   d: 3,   ht: 2.8 },
  armchair:    { label: 'Armchair',        group: 'Seating',  w: 3,   d: 3,   ht: 3 },
  chair:       { label: 'Chair',           group: 'Seating',  w: 1.7, d: 1.7, ht: 3 },
  bed:         { label: 'Queen bed',       group: 'Bedroom',  w: 5,   d: 7,   ht: 2 },
  kingbed:     { label: 'King bed',        group: 'Bedroom',  w: 6.5, d: 7,   ht: 2 },
  nightstand:  { label: 'Nightstand',      group: 'Bedroom',  w: 1.8, d: 1.5, ht: 2.2 },
  dresser:     { label: 'Dresser',         group: 'Bedroom',  w: 5,   d: 1.7, ht: 3 },
  coffeetable: { label: 'Coffee table',    group: 'Tables',   w: 4,   d: 2,   ht: 1.5 },
  sidetable:   { label: 'Side table',      group: 'Tables',   w: 1.8, d: 1.8, ht: 2 },
  desk:        { label: 'Desk',            group: 'Tables',   w: 5,   d: 2.5, ht: 2.5 },
  diningtable: { label: 'Dining table',    group: 'Tables',   w: 6,   d: 3.3, ht: 2.5 },
  bookshelf:   { label: 'Bookshelf',       group: 'Other',    w: 3,   d: 1,   ht: 6 },
  rug:         { label: 'Rug',             group: 'Other',    w: 8,   d: 5,   ht: 0.05 },
  plant:       { label: 'Plant',           group: 'Other',    w: 1.5, d: 1.5, ht: 4 },
  door:        { label: 'Door',            group: 'Other',    w: 3,   d: 0.3, ht: 7 },
  window:      { label: 'Window',          group: 'Other',    w: 4,   d: 0.3, ht: 4 },

  // Outside. Lights can sit on, under or along any of these.
  pergola:     { label: 'Pergola',         group: 'Outdoor structures', w: 12,  d: 10,  ht: 9 },
  gazebo:      { label: 'Gazebo',          group: 'Outdoor structures', w: 12,  d: 12,  ht: 11 },
  fence:       { label: 'Fence',           group: 'Outdoor structures', w: 12,  d: 0.4, ht: 5 },
  railing:     { label: 'Deck railing',    group: 'Outdoor structures', w: 10,  d: 0.3, ht: 3.2 },
  deck:        { label: 'Deck',            group: 'Outdoor structures', w: 14,  d: 12,  ht: 1.5 },
  patio:       { label: 'Patio',           group: 'Outdoor structures', w: 14,  d: 12,  ht: 0.1 },
  path:        { label: 'Path',            group: 'Outdoor structures', w: 3,   d: 14,  ht: 0.05 },
  housewall:   { label: 'House wall',      group: 'Outdoor structures', w: 24,  d: 0.8, ht: 10 },
  shed:        { label: 'Shed',            group: 'Outdoor structures', w: 8,   d: 10,  ht: 8 },
  pool:        { label: 'Pool',            group: 'Yard',     w: 16,  d: 32,  ht: 0.3 },
  hottub:      { label: 'Hot tub',         group: 'Yard',     w: 7,   d: 7,   ht: 3 },
  firepit:     { label: 'Fire pit',        group: 'Yard',     w: 4,   d: 4,   ht: 1.4 },
  patiotable:  { label: 'Table + umbrella', group: 'Yard',    w: 4,   d: 4,   ht: 7.5 },
  lounger:     { label: 'Lounge chair',    group: 'Yard',     w: 2.4, d: 6.5, ht: 1.6 },
  outdoorsofa: { label: 'Outdoor sofa',    group: 'Yard',     w: 7,   d: 3,   ht: 2.6 },
  grill:       { label: 'Grill',           group: 'Yard',     w: 4.5, d: 2,   ht: 3.8 },
  tree:        { label: 'Tree',            group: 'Yard',     w: 10,  d: 10,  ht: 16 },
  shrub:       { label: 'Shrub',           group: 'Yard',     w: 3,   d: 3,   ht: 3 },
  hedge:       { label: 'Hedge',           group: 'Yard',     w: 8,   d: 2.5, ht: 3.5 },
  gardenbed:   { label: 'Garden bed',      group: 'Yard',     w: 8,   d: 3,   ht: 1.2 },
};

export const OUTDOOR_GROUPS = ['Outdoor structures', 'Yard'];

export const SCREEN_KINDS = ['tv', 'screen'];
