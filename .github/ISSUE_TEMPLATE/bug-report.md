## 🐞 Title

Custom resource does not delete GSIs when their count is reduced

---

## 🐞 Summary

When increasing the number of GSIs, the update works correctly.  
However, when reducing the number of GSIs, the removed GSIs are not deleted.

---

## 📋 Steps to Reproduce

1. Deploy a DynamoDB table with multiple GSIs.
2. Reduce the number of GSIs in the custom resource definition and redeploy.

---

## ✅ Expected Behavior

The removed GSIs should be deleted from the DynamoDB table,  
so that the actual table configuration matches the GSI definitions passed to the custom resource.

---

## ❌ Actual Behavior

The removed GSIs remain on the DynamoDB table and are not deleted.

---

## 🖥️ Environment

- AWS CDK version: (e.g. 2.152.0)
- Node.js version: (e.g. 18.18.2)
- Runtime: NodeJS_18_X
- AWS region: (e.g. ap-northeast-1)
- Deployment method: (CDK deploy / Pipeline / Manual)

---

## 📦 Logs / Screenshots
