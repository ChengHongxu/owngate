This certificate and private key are public test fixtures for an in-process SMTP
server on `127.0.0.1`. Never use them for a deployment. The certificate covers
`localhost` and `127.0.0.1`, is valid from 2020 through 2120, and is trusted only
by the test's internal sender wrapper through `tls.ca`. Production channel
configuration cannot disable certificate verification or supply this test CA.
