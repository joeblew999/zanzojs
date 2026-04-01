-- Zanzo tuples — authorization
CREATE TABLE IF NOT EXISTS zanzo_tuples (
  subject  TEXT NOT NULL,
  relation TEXT NOT NULL,
  object   TEXT NOT NULL,
  UNIQUE(subject, relation, object)
);

CREATE INDEX IF NOT EXISTS idx_zanzo_subject_relation ON zanzo_tuples(subject, relation);
CREATE INDEX IF NOT EXISTS idx_zanzo_object_relation  ON zanzo_tuples(object, relation);

