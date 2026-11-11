package astm

// Class is the agent-side message classification (TRD §5.3).
type Class string

const (
	ClassData      Class = "data"
	ClassHostQuery Class = "host_query"
	ClassOther     Class = "other"
)

// Classify: any R record → data; else any Q record → host_query; else other.
// No H record → other (fail closed).
func Classify(raw []byte) Class {
	m := Tokenize(raw)
	q := false
	for _, r := range m.Records {
		switch r.Type {
		case 'R':
			return ClassData
		case 'Q':
			q = true
		}
	}
	if q {
		return ClassHostQuery
	}
	return ClassOther
}
