# Billing register exports (XML / PDF)

Exports are created from the Export button on `/billing/registers` (sales register, cancelled invoices, credit notes), `/billing/audit-trail` and `/billing/daily-cash`. The XML schema below is defined by this system (`urn:lims:billing:export:v1`). It is not an IRD schema, and the system does not submit exports to the IRD. Use the files for your own records or to give to your accountant.

Task `billing.export_render` (enqueued by B28 `createBillingExport`, maxAttempts 5) builds the file and stores it in the private bucket `billing-exports` at `{tenant_id}/{yyyy}/{mm}/{export_id}.{xml|pdf}` (write-once). `billing.export_purge` (cron `30 19 * * *`, per tenant) deletes the objects 24 h after completion and marks the row `expired`; expired / failed rows are removed after 90 days. The only way to read a file is B29a `getBillingExportContent` (streamed, `attachment`, `nosniff`, `no-store`); there is no Storage URL. Every create and every download writes an `audit.access_log` row (`data.export`, `billing_export`, `detail.stage` = `create` | `download`).

## XML format `urn:lims:billing:export:v1`

- One root `Export` element; attributes `kind` (sales_register, cancelled_invoices, credit_notes, audit_trail, daily_cash, invoice_documents), `generated_at` (the job's `created_at`, so a retry writes the same bytes) and `row_count`.
- Rows are direct children of the root, all of one row type (the one that belongs to `kind`; `invoice_documents` uses `SalesRow`).
- Money is integer paisa (NPR) in an `xs:long` element, never a decimal. A.D. dates are the Asia/Kathmandu calendar date; B.S. dates are `YYYY-MM-DD`.
- Optional elements (`BuyerPan`, `CreditNoteNo`, `EntityId`, `DocumentNo`) are absent, not empty, when the value is unknown. Text is XML-escaped; characters XML 1.0 forbids are dropped. `activity_log.details` is never exported.
- The statutory column set is UNVERIFIED (B6); the schema is versioned by its namespace.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:lims:billing:export:v1"
           targetNamespace="urn:lims:billing:export:v1" elementFormDefault="qualified">

  <xs:simpleType name="ExportKind">
    <xs:restriction base="xs:string">
      <xs:enumeration value="sales_register"/>
      <xs:enumeration value="cancelled_invoices"/>
      <xs:enumeration value="credit_notes"/>
      <xs:enumeration value="audit_trail"/>
      <xs:enumeration value="daily_cash"/>
      <xs:enumeration value="invoice_documents"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="CreditNoteKind">
    <xs:restriction base="xs:string">
      <xs:enumeration value="cancellation"/>
      <xs:enumeration value="partial"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="BsDate">
    <xs:restriction base="xs:string"><xs:pattern value="[0-9]{4}-[0-9]{2}-[0-9]{2}"/></xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="Uuid">
    <xs:restriction base="xs:string"><xs:pattern value="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"/></xs:restriction>
  </xs:simpleType>

  <xs:complexType name="SalesRow">
    <xs:sequence>
      <xs:element name="Sn" type="xs:positiveInteger"/>
      <xs:element name="InvoiceDateBs" type="tns:BsDate"/>
      <xs:element name="InvoiceDateAd" type="xs:date"/>
      <xs:element name="InvoiceNo" type="xs:string"/>
      <xs:element name="BuyerName" type="xs:string"/>
      <xs:element name="BuyerPan" type="xs:string" minOccurs="0"/>
      <xs:element name="Total" type="xs:long"/>
      <xs:element name="Exempt" type="xs:long"/>
      <xs:element name="Taxable" type="xs:long"/>
      <xs:element name="Vat" type="xs:long"/>
      <xs:element name="OtherTax" type="xs:long"/>
      <xs:element name="Status" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>

  <xs:complexType name="CancelledRow">
    <xs:sequence>
      <xs:element name="Sn" type="xs:positiveInteger"/>
      <xs:element name="CancelledDateBs" type="tns:BsDate"/>
      <xs:element name="CancelledDateAd" type="xs:date"/>
      <xs:element name="InvoiceNo" type="xs:string"/>
      <xs:element name="CreditNoteNo" type="xs:string" minOccurs="0"/>
      <xs:element name="BuyerName" type="xs:string"/>
      <xs:element name="BuyerPan" type="xs:string" minOccurs="0"/>
      <xs:element name="Total" type="xs:long"/>
      <xs:element name="ReasonCode" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>

  <xs:complexType name="CreditNoteRow">
    <xs:sequence>
      <xs:element name="Sn" type="xs:positiveInteger"/>
      <xs:element name="CreditNoteDateBs" type="tns:BsDate"/>
      <xs:element name="CreditNoteDateAd" type="xs:date"/>
      <xs:element name="CreditNoteNo" type="xs:string"/>
      <xs:element name="Kind" type="tns:CreditNoteKind"/>
      <xs:element name="InvoiceNo" type="xs:string"/>
      <xs:element name="BuyerName" type="xs:string"/>
      <xs:element name="BuyerPan" type="xs:string" minOccurs="0"/>
      <xs:element name="ReasonCode" type="xs:string"/>
      <xs:element name="Exempt" type="xs:long"/>
      <xs:element name="Taxable" type="xs:long"/>
      <xs:element name="Vat" type="xs:long"/>
      <xs:element name="OtherTax" type="xs:long"/>
      <xs:element name="Net" type="xs:long"/>
    </xs:sequence>
  </xs:complexType>

  <xs:complexType name="ActivityRow">
    <xs:sequence>
      <xs:element name="OccurredAt" type="xs:dateTime"/>
      <xs:element name="Action" type="xs:string"/>
      <xs:element name="EntityType" type="xs:string"/>
      <xs:element name="EntityId" type="tns:Uuid" minOccurs="0"/>
      <xs:element name="DocumentNo" type="xs:string" minOccurs="0"/>
      <xs:element name="ActorMembershipId" type="tns:Uuid" minOccurs="0"/>
    </xs:sequence>
  </xs:complexType>

  <xs:complexType name="CashRow">
    <xs:sequence>
      <xs:element name="BusinessDate" type="xs:date"/>
      <xs:element name="MethodCode" type="xs:string"/>
      <xs:element name="EntryKind" type="xs:string"/>
      <xs:element name="Amount" type="xs:long"/>
    </xs:sequence>
  </xs:complexType>

  <xs:element name="Export">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="SalesRow" type="tns:SalesRow" minOccurs="0" maxOccurs="unbounded"/>
        <xs:element name="CancelledRow" type="tns:CancelledRow" minOccurs="0" maxOccurs="unbounded"/>
        <xs:element name="CreditNoteRow" type="tns:CreditNoteRow" minOccurs="0" maxOccurs="unbounded"/>
        <xs:element name="ActivityRow" type="tns:ActivityRow" minOccurs="0" maxOccurs="unbounded"/>
        <xs:element name="CashRow" type="tns:CashRow" minOccurs="0" maxOccurs="unbounded"/>
      </xs:sequence>
      <xs:attribute name="kind" type="tns:ExportKind" use="required"/>
      <xs:attribute name="generated_at" type="xs:dateTime" use="required"/>
      <xs:attribute name="row_count" type="xs:nonNegativeInteger" use="required"/>
    </xs:complexType>
  </xs:element>
</xs:schema>
```

Validate a file with any XSD 1.0 engine, e.g. `xmllint --noout --schema exports.xsd export.xml` (save the block above as `exports.xsd`). The unit tests use a small in-repo validator (subset of XSD: sequence, enumeration, pattern, occurrence), so run a real engine once before the first statutory hand-over.

## PDF

`RenderPort.renderPdf(ctx, { templateKey: 'billing.register', data, idempotencyKey: 'billing-export:<export_id>' })` as the billing system actor (CR-C4-004); C4 stores the returned bytes itself. At most 5,000 rows (`LIMS_BILLING_EXPORT_PDF_MAX_ROWS`); more fails the job with `billing.export_too_large`. XLSX is `common.feature_disabled` until BL-T19.
