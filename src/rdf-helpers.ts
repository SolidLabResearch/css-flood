export const RDFTypeValues = [
  "TURTLE",
  "N_TRIPLES",
  "JSON_LD",
  "N3",
  "N_QUADS",
  "RDF_XML",
] as const;
export type RDFType = typeof RDFTypeValues[number];
export const RDFContentTypeMap: { [Property in RDFType]: string } = {
  TURTLE: "text/turtle",
  N_TRIPLES: "application/n-triples",
  RDF_XML: "application/rdf+xml",
  JSON_LD: "application/ld+json",
  N3: "text/n3;charset=utf-8",
  N_QUADS: "application/n-quads",
};
export const RDFFormatMap: { [Property in RDFType]: string } = {
  TURTLE: "Turtle",
  N_TRIPLES: "N-Triples",
  RDF_XML: "RDF/XML",
  JSON_LD: "JSON-LD",
  N3: "Notation3",
  N_QUADS: "N-Quads",
};
export const RDFExtMap: { [Property in RDFType]: string } = {
  TURTLE: "ttl", //or .turtle
  N_TRIPLES: "nt", //or .ntriples
  N_QUADS: "nq", //or .nquads
  RDF_XML: "rdf", //or .rdfxml or .owl
  JSON_LD: "jsonld", // or .json
  N3: "n3",
};
