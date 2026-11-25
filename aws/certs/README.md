# Public AWS trust material

The hosted image verifies the `us-east-1` RDS hostname and TLS certificate with `rds.pem`. It verifies EC2-signed worker identity documents with the `us-east-1` RSA public certificate in `ec2-iid.pem`.

- [Amazon RDS regional certificate bundle](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html#UsingWithRDS.SSL.RegionDownload)
- [Amazon EC2 regional public certificates](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/regions-certs.html)
