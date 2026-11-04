# Example requests

Replace the example parish hostname, credentials, and `REPORT_ID` with values for your own test parish. These examples use undocumented endpoints that may change. Treat the generated cookie file as a credential and keep it out of version control.

## Login
```
curl -c flocknote.cookie \
-X POST "https://example-parish.flocknote.com/login/password" \
-d '{"email":"user@example.com","password":"YOUR_PASSWORD"}'
```

## Report
```
curl -b flocknote.cookie \
-X POST "https://example-parish.flocknote.com/unolytics/REPORT_ID/getReport" \
--data-urlencode "startDate=2022-05-29" \
--data-urlencode "endDate=2022-06-29" \
--data-urlencode "reportType=notesSent"
```
