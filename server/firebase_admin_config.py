"""
Firebase Admin SDK Configuration
==================================
Server-side Firebase access for saving inference results
to Cloud Firestore.

Setup:
1. Go to Firebase Console > Project Settings > Service Accounts
2. Click "Generate New Private Key"
3. Save the JSON file as 'service-account-key.json' in the server/ directory
4. Set GOOGLE_APPLICATION_CREDENTIALS env var (optional)
"""

import os
import logging
from datetime import datetime

logger = logging.getLogger('sprout-server')

# Firebase Admin initialization
db = None

def initialize_firebase():
    """Initialize Firebase Admin SDK."""
    global db

    try:
        import firebase_admin
        from firebase_admin import credentials, firestore

        # Check for service account key file
        key_path = os.environ.get(
            'GOOGLE_APPLICATION_CREDENTIALS',
            os.path.join(os.path.dirname(__file__), 'service-account-key.json')
        )

        if os.path.exists(key_path):
            cred = credentials.Certificate(key_path)
            firebase_admin.initialize_app(cred)
            db = firestore.client()
            logger.info(f"✅ Firebase Admin initialized with key: {key_path}")
        else:
            # Try default credentials (GCE, Cloud Run, etc.)
            firebase_admin.initialize_app()
            db = firestore.client()
            logger.info("✅ Firebase Admin initialized with default credentials")

        return True

    except Exception as e:
        logger.warning(f"⚠️  Firebase Admin init failed: {e}")
        logger.warning("   Inference results won't be saved to Firestore.")
        return False


def save_inference_result(result_type: str, data: dict, user_id: str = None):
    """
    Save an inference result to Firestore.

    Args:
        result_type: 'detection', 'classification', or 'path'
        data: The inference result data
        user_id: Optional user ID to associate the result with

    Saves to: inference_results/{auto_id}
    """
    if db is None:
        logger.warning("Firebase not initialized — skipping save")
        return None

    try:
        doc_data = {
            'type': result_type,
            'data': data,
            'timestamp': datetime.now(),
            'rover_id': 'S-104',
        }

        if user_id:
            doc_data['user_id'] = user_id

        doc_ref = db.collection('inference_results').add(doc_data)
        logger.info(f"💾 Inference result saved to Firestore: {result_type}")
        return doc_ref

    except Exception as e:
        logger.error(f"Firestore save error: {e}")
        return None


def get_recent_results(result_type: str = None, limit: int = 20) -> list:
    """
    Get recent inference results from Firestore.

    Args:
        result_type: Optional filter by type
        limit: Max results to return

    Returns:
        List of inference result dicts
    """
    if db is None:
        return []

    try:
        query = db.collection('inference_results')
        if result_type:
            query = query.where('type', '==', result_type)
        query = query.order_by('timestamp', direction='DESCENDING').limit(limit)

        results = []
        for doc in query.stream():
            result = doc.to_dict()
            result['id'] = doc.id
            results.append(result)

        return results

    except Exception as e:
        logger.error(f"Firestore query error: {e}")
        return []


# Auto-initialize on import
initialize_firebase()
